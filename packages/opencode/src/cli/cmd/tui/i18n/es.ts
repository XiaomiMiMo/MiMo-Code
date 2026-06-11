import { dict as en } from "./en"

type Keys = keyof typeof en

export const dict = {
  // Language names
  "language.en": "English",
  "language.zh": "简体中文",
  "language.zht": "繁體中文",
  "language.ko": "한국어",
  "language.de": "Deutsch",
  "language.es": "Español",
  "language.fr": "Français",
  "language.da": "Dansk",
  "language.ja": "日本語",
  "language.pl": "Polski",
  "language.ru": "Русский",
  "language.ar": "العربية",
  "language.no": "Norsk",
  "language.br": "Português (Brasil)",
  "language.bs": "Bosanski",
  "language.th": "ไทย",
  "language.tr": "Türkçe",

  // Prompt placeholders
  "tui.prompt.placeholder.normal": 'Pregunta lo que quieras... "{{example}}"',
  "tui.prompt.placeholder.shell": 'Ejecuta un comando... "{{example}}"',
  "tui.prompt.ghost": "{{prediction}}  (Tab para aceptar)",
  "tui.home.placeholder.example.todo": "Corregir un TODO en el código",
  "tui.home.placeholder.example.stack": "¿Cuál es el stack técnico del proyecto?",
  "tui.home.placeholder.example.tests": "Arreglar las pruebas fallidas",

  // Prompt bottom hints (trigger characters)
  "tui.prompt.hint.attach_file": "adjuntar archivo",
  "tui.prompt.hint.subagent": "subagente",
  "tui.prompt.hint.commands": "comandos",
  "tui.prompt.hint.switch_mode": "cambiar modo",
  "tui.prompt.hint.settings": "ajustes",

  // Tips
  "tui.tips.label": "Sugerencia",
  "tui.tips.plain_terminal": "Recomendamos usar iTerm o la terminal de VS Code",
  "tui.tips.attach_file":
    "Escribe {highlight}@{/highlight} seguido del nombre de archivo para buscar de forma difusa y adjuntar archivos",
  "tui.tips.shell_prefix":
    "Empieza un mensaje con {highlight}!{/highlight} para ejecutar comandos del shell directamente (p. ej., {highlight}!ls -la{/highlight})",
  "tui.tips.tab_agent":
    "Pulsa {highlight}Tab{/highlight} o {highlight}Shift+Tab{/highlight} para alternar entre los agentes Build, Plan y Compose",
  "tui.tips.theme_mode":
    "Ejecuta {highlight}/dark{/highlight} para el modo oscuro o {highlight}/light{/highlight} para el modo claro",
  "tui.tips.doc": "Ejecuta {highlight}/doc{/highlight} para abrir la documentación de usuario",
  "tui.tips.free_models": "Modelos gratuitos disponibles por tiempo limitado — ¡pruébalos ahora!",
  "tui.tips.background":
    "Ejecuta {highlight}/background{/highlight} para usar una imagen personalizada como fondo de inicio",
  "tui.tips.undo":
    "Usa {highlight}/undo{/highlight} para revertir el último mensaje y los cambios en archivos",
  "tui.tips.redo":
    "Usa {highlight}/redo{/highlight} para restaurar mensajes y cambios deshechos previamente",
  "tui.tips.share":
    "Ejecuta {highlight}/share{/highlight} para crear un enlace público a tu conversación en opencode.ai",
  "tui.tips.drag_drop": "Arrastra y suelta imágenes o PDF en el terminal para añadirlos como contexto",
  "tui.tips.paste_image":
    "Pulsa {highlight}Ctrl+V{/highlight} para pegar imágenes desde el portapapeles en la entrada",
  "tui.tips.editor":
    "Pulsa {highlight}Ctrl+X E{/highlight} o {highlight}/editor{/highlight} para componer mensajes en tu editor externo",
  "tui.tips.init":
    "Ejecuta {highlight}/init{/highlight} para autogenerar reglas del proyecto a partir de tu código",
  "tui.tips.models":
    "Ejecuta {highlight}/models{/highlight} o {highlight}Ctrl+X M{/highlight} para cambiar entre los modelos disponibles",
  "tui.tips.theme":
    "Usa {highlight}/themes{/highlight} o {highlight}Ctrl+X T{/highlight} para alternar entre {{count}} temas integrados",
  "tui.tips.new_session":
    "Pulsa {highlight}Ctrl+X N{/highlight} o {highlight}/new{/highlight} para iniciar una nueva sesión",
  "tui.tips.sessions":
    "Usa {highlight}/sessions{/highlight} o {highlight}Ctrl+X L{/highlight} para listar y continuar conversaciones anteriores",
  "tui.tips.compact":
    "Ejecuta {highlight}/compact{/highlight} para resumir sesiones largas cerca del límite de contexto",
  "tui.tips.export":
    "Pulsa {highlight}Ctrl+X X{/highlight} o {highlight}/export{/highlight} para guardar la conversación como Markdown",
  "tui.tips.copy_last":
    "Pulsa {highlight}Ctrl+X Y{/highlight} para copiar el último mensaje del asistente al portapapeles",
  "tui.tips.command_palette":
    "Pulsa {highlight}Ctrl+P{/highlight} para ver todas las acciones y comandos disponibles",
  "tui.tips.login":
    "Ejecuta {highlight}/login{/highlight} para iniciar sesión y usar tu plan de tokens",
  "tui.tips.connect":
    "Ejecuta {highlight}/connect{/highlight} para elegir tu proveedor LLM y añadir claves API",
  "tui.tips.leader":
    "La tecla líder es {highlight}Ctrl+X{/highlight}; combínala con otras teclas para acciones rápidas",
  "tui.tips.f2": "Pulsa {highlight}F2{/highlight} para alternar rápidamente entre los modelos usados recientemente",
  "tui.tips.sidebar": "Pulsa {highlight}Ctrl+X B{/highlight} para mostrar/ocultar la barra lateral",
  "tui.tips.history":
    "Usa {highlight}PageUp{/highlight}/{highlight}PageDown{/highlight} para navegar por el historial de la conversación",
  "tui.tips.jump_first":
    "Pulsa {highlight}Ctrl+G{/highlight} o {highlight}Home{/highlight} para ir al inicio de la conversación",
  "tui.tips.jump_last":
    "Pulsa {highlight}Ctrl+Alt+G{/highlight} o {highlight}End{/highlight} para ir al mensaje más reciente",
  "tui.tips.newline":
    "Pulsa {highlight}Shift+Enter{/highlight} o {highlight}Ctrl+J{/highlight} para añadir saltos de línea en la entrada",
  "tui.tips.clear_input":
    "Pulsa {highlight}Ctrl+C{/highlight} mientras escribes para vaciar el campo de entrada",
  "tui.tips.escape": "Pulsa {highlight}Escape{/highlight} para detener la respuesta de la IA en curso",
  "tui.tips.plan_agent":
    "Cambia al agente {highlight}Plan{/highlight} para obtener sugerencias sin aplicar cambios reales",
  "tui.tips.subagent":
    "Usa {highlight}@agent-name{/highlight} en las indicaciones para invocar subagentes especializados",
  "tui.tips.cycle_sessions":
    "Pulsa {highlight}Ctrl+X Right/Left{/highlight} para alternar entre sesiones padre e hija",
  "tui.tips.config_files":
    "Crea {highlight}mimocode.json{/highlight} para la configuración del servidor y {highlight}tui.json{/highlight} para la TUI",
  "tui.tips.global_config":
    "Coloca la configuración de TUI en {highlight}~/.config/mimocode/tui.json{/highlight} como configuración global",
  "tui.tips.schema":
    "Añade {highlight}$schema{/highlight} a tu configuración para autocompletado en el editor",
  "tui.tips.default_model":
    "Configura {highlight}model{/highlight} en la config para definir tu modelo por defecto",
  "tui.tips.keybinds":
    "Sobrescribe cualquier atajo en {highlight}tui.json{/highlight} mediante la sección {highlight}keybinds{/highlight}",
  "tui.tips.disable_keybind":
    "Establece un atajo en {highlight}none{/highlight} para deshabilitarlo por completo",
  "tui.tips.mcp_config":
    "Configura servidores MCP locales o remotos en la sección {highlight}mcp{/highlight}",
  "tui.tips.mcp_oauth":
    "MiMoCode gestiona automáticamente OAuth para servidores MCP remotos que requieran autenticación",
  "tui.tips.custom_command":
    "Añade archivos {highlight}.md{/highlight} en {highlight}.mimocode/command/{/highlight} para definir indicaciones personalizadas reutilizables",
  "tui.tips.command_args":
    "Usa {highlight}$ARGUMENTS{/highlight}, {highlight}$1{/highlight}, {highlight}$2{/highlight} en comandos personalizados para entradas dinámicas",
  "tui.tips.command_backticks":
    "Usa comillas invertidas en los comandos para inyectar la salida del shell (p. ej. {highlight}`git status`{/highlight})",
  "tui.tips.custom_agent":
    "Añade archivos {highlight}.md{/highlight} en {highlight}.mimocode/agent/{/highlight} para personajes de IA especializados",
  "tui.tips.agent_perms":
    "Configura por agente los permisos de las herramientas {highlight}edit{/highlight}, {highlight}bash{/highlight} y {highlight}webfetch{/highlight}",
  "tui.tips.bash_allow":
    'Usa patrones como {highlight}"git *": "allow"{/highlight} para permisos de bash más finos',
  "tui.tips.bash_deny":
    'Define {highlight}"rm -rf *": "deny"{/highlight} para bloquear comandos destructivos',
  "tui.tips.bash_ask":
    'Configura {highlight}"git push": "ask"{/highlight} para exigir confirmación antes de hacer push',
  "tui.tips.formatter": "MiMoCode formatea archivos automáticamente con prettier, gofmt, ruff y más",
  "tui.tips.disable_formatter":
    'Define {highlight}"formatter": false{/highlight} en la config para desactivar el formato automático',
  "tui.tips.custom_formatter":
    "Define comandos de formateo personalizados por extensión de archivo en la configuración",
  "tui.tips.lsp": "MiMoCode usa servidores LSP para análisis inteligente de código",
  "tui.tips.custom_tool":
    "Crea archivos {highlight}.ts{/highlight} en {highlight}.mimocode/tools/{/highlight} para definir nuevas herramientas LLM",
  "tui.tips.tool_scripts":
    "Las definiciones de herramientas pueden invocar scripts en Python, Go, etc.",
  "tui.tips.plugins":
    "Añade archivos {highlight}.ts{/highlight} en {highlight}.mimocode/plugin/{/highlight} para enganchar eventos",
  "tui.tips.plugin_notify":
    "Usa plugins para enviar notificaciones del sistema cuando termine una sesión",
  "tui.tips.plugin_protect":
    "Crea un plugin que impida a MiMoCode leer archivos sensibles",
  "tui.tips.run":
    "Usa {highlight}mimo run{/highlight} para scripting no interactivo",
  "tui.tips.continue":
    "Usa {highlight}mimo --continue{/highlight} para retomar la última sesión",
  "tui.tips.attach_cli":
    "Usa {highlight}mimo run -f file.ts{/highlight} para adjuntar archivos vía CLI",
  "tui.tips.format_json":
    "Usa {highlight}--format json{/highlight} para obtener salida legible por máquina en scripts",
  "tui.tips.serve":
    "Ejecuta {highlight}mimo serve{/highlight} para acceso headless a la API de MiMoCode",
  "tui.tips.attach_server":
    "Usa {highlight}mimo run --attach{/highlight} para conectarte a un servidor en ejecución",
  "tui.tips.upgrade":
    "Ejecuta {highlight}mimo upgrade{/highlight} para actualizar a la última versión",
  "tui.tips.auth_list":
    "Ejecuta {highlight}mimo auth list{/highlight} para ver todos los proveedores configurados",
  "tui.tips.agent_create":
    "Ejecuta {highlight}mimo agent create{/highlight} para crear un agente con asistente guiado",
  "tui.tips.github_trigger":
    "Usa {highlight}/opencode{/highlight} en issues/PR de GitHub para disparar acciones de IA",
  "tui.tips.github_install":
    "Ejecuta {highlight}mimo github install{/highlight} para configurar el workflow de GitHub",
  "tui.tips.github_oc":
    "Comenta {highlight}/oc{/highlight} en líneas de código de un PR para revisiones puntuales",
  "tui.tips.theme_system":
    'Usa {highlight}"theme": "system"{/highlight} para seguir los colores de tu terminal',
  "tui.tips.theme_files":
    "Crea archivos JSON de tema en el directorio {highlight}.mimocode/themes/{/highlight}",
  "tui.tips.theme_variants": "Los temas admiten variantes claras/oscuras para ambos modos",
  "tui.tips.theme_ansi": "Referencia colores ANSI 0-255 en temas personalizados",
  "tui.tips.env_var":
    "Usa la sintaxis {highlight}{env:VAR_NAME}{/highlight} para referenciar variables de entorno en la config",
  "tui.tips.file_var":
    "Usa {highlight}{file:path}{/highlight} para incluir el contenido de un archivo en valores de la config",
  "tui.tips.instructions":
    "Usa {highlight}instructions{/highlight} en la config para cargar archivos de reglas adicionales",
  "tui.tips.temperature":
    "Ajusta la {highlight}temperature{/highlight} del agente desde 0.0 (enfocado) hasta 1.0 (creativo)",
  "tui.tips.steps":
    "Configura {highlight}steps{/highlight} para limitar las iteraciones agénticas por petición",
  "tui.tips.disable_tool":
    'Define {highlight}"tools": {"bash": false}{/highlight} para deshabilitar herramientas concretas',
  "tui.tips.disable_mcp_tools":
    'Define {highlight}"mcp_*": false{/highlight} para deshabilitar todas las herramientas de un servidor MCP',
  "tui.tips.tool_override":
    "Sobrescribe la configuración global de herramientas en cada agente",
  "tui.tips.share_auto":
    'Define {highlight}"share": "auto"{/highlight} para compartir todas las sesiones automáticamente',
  "tui.tips.share_disabled":
    'Define {highlight}"share": "disabled"{/highlight} para impedir cualquier compartición de sesiones',
  "tui.tips.unshare":
    "Ejecuta {highlight}/unshare{/highlight} para retirar una sesión del acceso público",
  "tui.tips.doom_loop":
    "El permiso {highlight}doom_loop{/highlight} previene bucles infinitos de llamadas a herramientas",
  "tui.tips.external_dir":
    "El permiso {highlight}external_directory{/highlight} protege archivos fuera del proyecto",
  "tui.tips.debug_config":
    "Ejecuta {highlight}mimo debug config{/highlight} para diagnosticar problemas de configuración",
  "tui.tips.print_logs":
    "Usa la opción {highlight}--print-logs{/highlight} para ver logs detallados en stderr",
  "tui.tips.timeline":
    "Pulsa {highlight}Ctrl+X G{/highlight} o {highlight}/timeline{/highlight} para saltar a un mensaje concreto",
  "tui.tips.toggle_code":
    "Pulsa {highlight}Ctrl+X H{/highlight} para alternar la visibilidad de los bloques de código",
  "tui.tips.status":
    "Pulsa {highlight}Ctrl+X S{/highlight} o {highlight}/status{/highlight} para ver el estado del sistema",
  "tui.tips.scroll_accel":
    "Activa {highlight}scroll_acceleration{/highlight} en {highlight}tui.json{/highlight} para un desplazamiento suave",
  "tui.tips.username_toggle":
    "Activa/desactiva la visualización del nombre de usuario desde la paleta de comandos ({highlight}Ctrl+P{/highlight})",
  "tui.tips.docker":
    "Ejecuta {highlight}docker run -it --rm ghcr.io/anomalyco/opencode{/highlight} para uso en contenedor",
  "tui.tips.zen":
    "Usa {highlight}/connect{/highlight} con MiMo Code para modelos seleccionados y probados",
  "tui.tips.agents_md":
    "Sube el {highlight}AGENTS.md{/highlight} de tu proyecto a Git para compartirlo con el equipo",
  "tui.tips.review":
    "Usa {highlight}/review{/highlight} para revisar cambios sin commit, ramas o PR",
  "tui.tips.help":
    "Ejecuta {highlight}/help{/highlight} o {highlight}Ctrl+X H{/highlight} para abrir el diálogo de ayuda",
  "tui.tips.rename":
    "Usa {highlight}/rename{/highlight} para renombrar la sesión actual",
  "tui.tips.suspend.unix":
    "Pulsa {highlight}Ctrl+Z{/highlight} para suspender el terminal y volver al shell",
  "tui.tips.suspend.win":
    "Pulsa {highlight}Ctrl+Z{/highlight} para deshacer cambios en la entrada",

  // Command palette UI
  "tui.command.palette.title": "Comandos",
  "tui.command.palette.suggested": "Sugeridos",

  // Command categories
  "tui.command.category.session": "Sesión",
  "tui.command.category.agent": "Agente",
  "tui.command.category.provider": "Proveedor",
  "tui.command.category.system": "Sistema",
  "tui.command.category.prompt": "Entrada",
  "tui.command.category.internal": "Interno",
  "tui.command.category.external": "Externo",

  // Language switching
  "tui.command.language.switch.title": "Cambiar idioma",
  "tui.command.language.switch.description": "Cambiar el idioma de la interfaz",
  "tui.command.language.dialog.title": "Cambiar idioma",
  "tui.language.auto": "Auto (sistema)",
  "tui.language.current": "Actual",

  // App-level commands
  "tui.command.session.list.title": "Cambiar sesión",
  "tui.command.session.new.title": "Nueva sesión",
  "tui.command.workflow.list.title": "Flujos de trabajo",
  "tui.command.model.list.title": "Cambiar modelo",
  "tui.command.model.cycle_recent.title": "Ciclo de modelos",
  "tui.command.model.cycle_recent_reverse.title": "Ciclo de modelos (inverso)",
  "tui.command.model.cycle_favorite.title": "Ciclo de favoritos",
  "tui.command.model.cycle_favorite_reverse.title": "Ciclo de favoritos (inverso)",
  "tui.command.agent.list.title": "Cambiar agente",
  "tui.command.mcp.list.title": "Alternar MCP",
  "tui.command.never_ask.title_on": "Sin preguntas: ACTIVADO — desactivar (volver a preguntarme)",
  "tui.command.never_ask.title_off": "Sin preguntas: DESACTIVADO — activar (decidir sin preguntar)",
  "tui.command.never_ask.toast_on":
    "Sin preguntas ACTIVADO — no te preguntaré; elegiré la mejor opción yo mismo hasta que lo desactives (/never-ask-questions). Las solicitudes de permiso siguen requiriendo tu aprobación.",
  "tui.command.never_ask.toast_off": "Sin preguntas DESACTIVADO — volveré a preguntarte en los puntos de decisión.",
  "tui.command.agent.cycle.title": "Ciclo de agentes",
  "tui.command.variant.cycle.title": "Ciclo de variantes",
  "tui.command.variant.list.title": "Cambiar variante de modelo",
  "tui.command.agent.cycle.reverse.title": "Ciclo de agentes (inverso)",
  "tui.command.provider.login.title": "Iniciar sesión",
  "tui.command.provider.connect.title": "Conectar proveedor",
  "tui.command.provider.logout.title": "Cerrar sesión",
  "tui.command.console.org.switch.title": "Cambiar de organización",
  "tui.command.opencode.status.title": "Ver estado",
  "tui.command.theme.switch.title": "Cambiar tema",
  "tui.command.logo.switch.title": "Cambiar diseño de logo",
  "tui.dialog.logo.title": "Diseño de logo",
  "tui.dialog.logo.option.classic": "Clásico (negrita)",
  "tui.dialog.logo.option.thin": "Fino (medio bloque)",
  "tui.command.theme.switch_mode.to_light": "Cambiar a modo claro",
  "tui.command.theme.switch_mode.to_dark": "Cambiar a modo oscuro",
  "tui.command.theme.mode.unlock": "Desbloquear modo del tema",
  "tui.command.theme.mode.lock": "Bloquear modo del tema",
  "tui.command.help.show.title": "Ayuda",
  "tui.dialog.help.close_hint": "esc/enter",
  "tui.dialog.help.command_list": "Pulsa {{keybind}} para ver todas las acciones y comandos disponibles en cualquier contexto.",
  "tui.dialog.help.ok": "Aceptar",
  "tui.dialog.close_hint": "esc",
  "tui.dialog.ok": "Aceptar",
  "tui.dialog.confirm.cancel": "Cancelar",
  "tui.dialog.confirm.confirm": "Confirmar",
  "tui.dialog.select.placeholder": "Buscar",
  "tui.dialog.select.no_results": "No se encontraron resultados",
  "tui.dialog.prompt.placeholder": "Introduce texto",
  "tui.dialog.prompt.busy": "Trabajando...",
  "tui.dialog.prompt.processing": "procesando...",
  "tui.dialog.prompt.submit_key": "enter",
  "tui.dialog.prompt.submit_action": "enviar",
  "tui.dialog.export.title": "Opciones de exportación",
  "tui.dialog.export.filename": "Nombre de archivo:",
  "tui.dialog.export.filename_placeholder": "Introduce el nombre de archivo",
  "tui.dialog.export.include_thinking": "Incluir razonamiento",
  "tui.dialog.export.include_tool_details": "Incluir detalles de herramientas",
  "tui.dialog.export.include_assistant_metadata": "Incluir metadatos del asistente",
  "tui.dialog.export.open_without_saving": "Abrir sin guardar",
  "tui.dialog.export.hint.toggle_prefix": "Pulsa",
  "tui.dialog.export.hint.toggle_action": "para alternar",
  "tui.dialog.export.hint.confirm_action": "para confirmar",
  "tui.dialog.export.hint.options_action": "para opciones",
  "tui.toast.copied_to_clipboard": "Copiado al portapapeles",
  "tui.toast.instructions_loaded": "Cargado {{files}}",
  "tui.sidebar.instructions": "Instrucciones",
  "tui.sidebar.cwd": "Directorio de trabajo",
  "tui.toast.unknown_error": "Ha ocurrido un error desconocido",
  "tui.command.docs.open.title": "Abrir documentación",
  "tui.command.app.exit.title": "Salir de la aplicación",
  "tui.command.app.debug.title": "Alternar panel de depuración",
  "tui.command.app.console.title": "Alternar consola",
  "tui.command.app.heap_snapshot.title": "Exportar snapshot del heap",
  "tui.command.terminal.suspend.title": "Suspender terminal",
  "tui.command.terminal.title.disable": "Deshabilitar título del terminal",
  "tui.command.terminal.title.enable": "Habilitar título del terminal",
  "tui.command.app.toggle.animations.disable": "Deshabilitar animaciones",
  "tui.command.app.toggle.animations.enable": "Habilitar animaciones",
  "tui.command.app.toggle.diffwrap.disable": "Deshabilitar ajuste de diff",
  "tui.command.app.toggle.diffwrap.enable": "Habilitar ajuste de diff",
  "tui.command.logout.toast": "Sesión cerrada",

  // Session-level commands
  "tui.command.session.share.title": "Compartir sesión",
  "tui.command.session.share.copy_link": "Copiar enlace para compartir",
  "tui.command.session.rename.title": "Renombrar sesión",
  "tui.command.session.timeline.title": "Saltar a un mensaje",
  "tui.command.session.fork.title": "Bifurcar sesión",
  "tui.command.session.compact.title": "Compactar sesión",
  "tui.command.session.unshare.title": "Dejar de compartir",
  "tui.command.session.undo.title": "Deshacer mensaje anterior",
  "tui.command.session.redo.title": "Rehacer",
  "tui.command.session.sidebar.show": "Mostrar barra lateral",
  "tui.command.session.sidebar.hide": "Ocultar barra lateral",
  "tui.command.session.conceal.disable": "Deshabilitar ocultación de código",
  "tui.command.session.conceal.enable": "Habilitar ocultación de código",
  "tui.command.session.timestamps.show": "Mostrar marcas de tiempo",
  "tui.command.session.timestamps.hide": "Ocultar marcas de tiempo",
  "tui.command.session.thinking.expand": "Expandir razonamiento",
  "tui.command.session.thinking.collapse": "Colapsar razonamiento",
  "tui.command.session.tool_details.show": "Mostrar detalles de herramientas",
  "tui.command.session.tool_details.hide": "Ocultar detalles de herramientas",
  "tui.command.session.scrollbar.toggle": "Alternar barra de desplazamiento",
  "tui.command.session.generic_tool_output.show": "Mostrar salida de herramienta genérica",
  "tui.command.session.generic_tool_output.hide": "Ocultar salida de herramienta genérica",
  "tui.command.session.page_up.title": "Página anterior",
  "tui.command.session.page_down.title": "Página siguiente",
  "tui.command.session.line_up.title": "Línea arriba",
  "tui.command.session.line_down.title": "Línea abajo",
  "tui.command.session.half_page_up.title": "Media página arriba",
  "tui.command.session.half_page_down.title": "Media página abajo",
  "tui.command.session.first.title": "Primer mensaje",
  "tui.command.session.last.title": "Último mensaje",
  "tui.command.session.last_user.title": "Ir al último mensaje del usuario",
  "tui.command.session.message_next.title": "Mensaje siguiente",
  "tui.command.session.message_previous.title": "Mensaje anterior",
  "tui.command.messages.copy.title": "Copiar último mensaje del asistente",
  "tui.command.session.copy.title": "Copiar transcripción de la sesión",
  "tui.command.session.export.title": "Exportar transcripción",
  "tui.command.session.child_first.title": "Ir a la sesión hija",
  "tui.command.session.parent.title": "Ir a la sesión padre",
  "tui.command.session.child_next.title": "Sesión hija siguiente",
  "tui.command.session.child_previous.title": "Sesión hija anterior",

  // Prompt commands
  "tui.command.prompt.clear.title": "Vaciar entrada",
  "tui.command.prompt.submit.title": "Enviar prompt",
  "tui.command.prompt.paste.title": "Pegar",
  "tui.command.session.interrupt.title": "Interrumpir sesión",
  "tui.command.prompt.editor.title": "Abrir editor",
  "tui.command.prompt.skills.title": "Habilidades",
  "tui.command.voice.toggle.title": "Alternar entrada de voz",
  "tui.command.voice.toggle.title_on": "Entrada de voz: activada — clic para desactivar",
  "tui.command.voice.toggle.title_off": "Entrada de voz: desactivada — clic para activar",
  "tui.voice.enabled": "Entrada de voz activada (chino/inglés) — clic en [Voice] para grabar",
  "tui.voice.disabled": "Entrada de voz deshabilitada",
  "tui.voice.send.enabled": "Envío por voz habilitado — di「发送」o \"send it\" para enviar",
  "tui.voice.send.disabled": "Envío por voz deshabilitado",
  "tui.command.voice.send.title": "Alternar envío por voz",
  "tui.command.voice.send.title_on": "Envío por voz: activado — clic para desactivar",
  "tui.command.voice.send.title_off": "Envío por voz: desactivado — clic para activar",
  "tui.voice.control.enabled": "Control de voz habilitado — usa modelo multimodal para edición inteligente (más lento)",
  "tui.voice.control.disabled": "Control de voz deshabilitado — usa transcripción ASR rápida",
  "tui.command.voice.control.title": "Alternar control de voz (multimodal)",
  "tui.command.voice.control.title_on": "Control de voz: activado (multimodal) — clic para desactivar",
  "tui.command.voice.control.title_off": "Control de voz: desactivado (ASR rápido) — clic para activar",
  "tui.voice.error.no_auth": "Inicia sesión en MiMo primero",
  "tui.voice.error.no_recorder": "No se encontró herramienta de grabación, instala sox",
  "tui.voice.error.too_short": "Grabación demasiado corta",
  "tui.voice.error.network": "La transcripción falló, verifica tu red",
  "tui.voice.error.empty_send": "No hay contenido para enviar",
  "tui.voice.error.unknown_agent": "Agente \"{{name}}\" no encontrado",
  "tui.command.prompt.stash.title": "Guardar prompt",
  "tui.command.prompt.stash.pop.title": "Recuperar prompt",
  "tui.command.prompt.stash.list.title": "Lista de prompts guardados",

  // Tips toggle / Plugins
  "tui.command.tips.toggle.show": "Mostrar sugerencias",
  "tui.command.tips.toggle.hide": "Ocultar sugerencias",
  "tui.command.plugins.list.title": "Plugins",
  "tui.command.plugins.install.title": "Instalar plugin",

  // Question i18n — plan_exit
  "tui.question.plan_exit.question": "El plan en {{plan}} está completo. ¿Desea cambiar al agente build para comenzar la implementación?",
  "tui.question.plan_exit.header": "Salir del plan",
  "tui.question.plan_exit.option.0.label": "Sí",
  "tui.question.plan_exit.option.0.description": "Cambiar al agente build y comenzar la implementación del plan",
  "tui.question.plan_exit.option.1.label": "No",
  "tui.question.plan_exit.option.1.description": "Permanecer con el agente plan para seguir refinando",

  // Session badges
  "tui.session.badge.auto": "Auto",
} satisfies Partial<Record<Keys, string>>
