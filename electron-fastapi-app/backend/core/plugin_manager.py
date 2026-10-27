import importlib
import inspect
from pathlib import Path
from typing import List
from fastapi import APIRouter, FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

class PluginManager:
  def __init__(self, app: FastAPI, project_root: Path):
    self.app = app
    self.project_root = project_root
    self.plugins_dir = self.project_root / "plugins"
    self.global_static = self.project_root / "static"
    self.global_templates = self.project_root / "templates"
    
    self.template_dirs: List[Path] = []
    self.loaded_plugins: List[str] = []
    self.loaded_plugins_dirs: List[str] = []

  def get_loaded_routers(self):
    return self.loaded_plugins_dirs
  
  def discover_and_load(self):
    """
    Punto de entrada principal. Inicia el escaneo recursivo y establece 
    los montajes globales como fallback (evitando shadowing).
    """
    if not self.plugins_dir.exists() or not self.plugins_dir.is_dir():
      raise FileNotFoundError(f"Directorio de plugins no encontrado: {self.plugins_dir}")

    # 1. Escaneo topológico de dominios y submódulos (recursivo)
    self._scan_recursively(self.plugins_dir)

    # 2. Montaje estático global (Resolución de fallback en ASGI)
    if self.global_static.exists() and self.global_static.is_dir():
      self.app.mount(
        "/static",
        StaticFiles(directory=str(self.global_static)),
        name="static_global",
      )

  def _scan_recursively(self, current_path: Path):
    """
    Recorre el árbol de directorios ignorando artefactos de Python y sistemas,
    delegando la evaluación de recursos cuando detecta un paquete válido.
    """
    for path in current_path.iterdir():
      if path.is_dir() and not path.name.startswith((".", "_", "__")):
        # Prevenir escaneo en carpetas de datos internas del plugin
        if path.name in ["data", "background_processes", "backgroundProcesses", "fails"]:
          continue
          
        self._evaluate_plugin_node(path)
        self._scan_recursively(path)

  def _evaluate_plugin_node(self, plugin_path: Path):
    """
    Evalúa un nodo del directorio. Construye espacios de nombres dinámicos 
    basados en la ruta relativa desde la raíz de plugins.
    """
    # Ej: Posición actual: plugins/medioambiente/riles
    # rel_path = medioambiente/riles
    rel_path = plugin_path.relative_to(self.plugins_dir)
    namespace_parts = rel_path.parts
    
    # Si estamos en la raíz de plugins, no hay espacio de nombres
    if not namespace_parts:
      return

    # Construcción de identificadores dinámicos
    # url_namespace -> medioambiente/riles
    # name_namespace -> medioambiente_riles
    url_namespace = "/".join(namespace_parts)
    name_namespace = "_".join(namespace_parts)

    # --- 1. Montaje de Estáticos Aislados ---
    plugin_static = plugin_path / "static"
    if plugin_static.exists() and plugin_static.is_dir():
      mount_name = f"static_{name_namespace}"
      url_prefix = f"/static/plugins/{url_namespace}"
      
      self.app.mount(
        url_prefix,
        StaticFiles(directory=str(plugin_static)),
        name=mount_name,
      )

    # --- 2. Recolección de Plantillas ---
    for template_folder in ["pages", "templates"]:
      t_dir = plugin_path / template_folder
      if t_dir.exists() and t_dir.is_dir():
        self.template_dirs.append(t_dir)

    # --- 3. Carga Dinámica de Routers (Convención por Homonimia) ---
    # Busca un archivo .py que coincida con el nombre de la carpeta (ej. riles.py)
    # y opcionalmente chequea un main.py como fallback
    entry_points = [
      plugin_path / f"{plugin_path.name}.py",
      plugin_path / "main.py"
    ]

    for entry_point in entry_points:
      if entry_point.exists() and entry_point.is_file():
        # Transforma plugins/medioambiente/riles/riles.py -> plugins.medioambiente.riles.riles
        module_path = ".".join(["plugins"] + list(namespace_parts) + [entry_point.stem])
        self._import_routers_from_module(module_path, name_namespace)
        break # Si encuentra el router primario, detiene la búsqueda en esta carpeta

  def _import_routers_from_module(self, module_path: str, plugin_id: str):
    try:
      module = importlib.import_module(module_path)
      for attr_name, attr_value in inspect.getmembers(module):
        if isinstance(attr_value, APIRouter):
          if getattr(attr_value, "_registered_in_app", False):
            continue
          self.app.include_router(attr_value)
          setattr(attr_value, "_registered_in_app", True)
          self.loaded_plugins.append(f"[{plugin_id}] Montado: {module_path}:{attr_name}")
          self.loaded_plugins_dirs.append(f"{module_path}:{attr_name}")
    except Exception as e:
      print(f"❌ Error crítico en módulo {module_path}: {e}")


  def get_jinja_templates(self) -> Jinja2Templates:
    """
    Retorna la instancia de Jinja2 con resolución de fallback.
    Prioridad 1: Plantillas locales del plugin (/plugins/.../pages/)
    Prioridad 2: Plantillas globales (/templates/)
    """
    all_dirs = []
    
    # Inyección de directorios descubiertos en orden de precedencia
    all_dirs.extend([str(d) for d in self.template_dirs])

    if self.global_templates.exists() and self.global_templates.is_dir():
      all_dirs.append(str(self.global_templates))

    return Jinja2Templates(directory=all_dirs)