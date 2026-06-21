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
  "tui.prompt.placeholder.normal": 'Спросите что угодно... "{{example}}"',
  "tui.prompt.placeholder.shell": 'Выполните команду... "{{example}}"',
  "tui.prompt.ghost": "{{prediction}}  (Tab — принять)",
  "tui.home.placeholder.example.todo": "Исправь TODO в кодовой базе",
  "tui.home.placeholder.example.stack": "Какой технологический стек у этого проекта?",
  "tui.home.placeholder.example.tests": "Почини сломанные тесты",
  "tui.home.agreement.prefix": "Используя MiMoCode, вы соглашаетесь с нашими ",
  "tui.home.agreement.terms": "Условиями использования",
  "tui.home.agreement.separator": " и ",
  "tui.home.agreement.privacy": "Политикой конфиденциальности",
  "tui.home.agreement.suffix": "",

  // Prompt bottom hints (trigger characters)
  "tui.prompt.hint.attach_file": "прикрепить файл",
  "tui.prompt.hint.subagent": "субагент",
  "tui.prompt.hint.commands": "команды",
  "tui.prompt.hint.switch_mode": "сменить режим",
  "tui.prompt.hint.settings": "настройки",

  // Tips
  "tui.tips.label": "Подсказка",
  "tui.tips.plain_terminal": "Рекомендуем использовать iTerm или терминал VS Code",
  "tui.tips.attach_file":
    "Введите {highlight}@{/highlight}, а затем имя файла, чтобы выполнить нечёткий поиск и прикрепить файлы",
  "tui.tips.shell_prefix":
    "Начните сообщение с {highlight}!{/highlight}, чтобы выполнить shell-команду напрямую (например, {highlight}!ls -la{/highlight})",
  "tui.tips.tab_agent":
    "Нажмите {highlight}Tab{/highlight} или {highlight}Shift+Tab{/highlight}, чтобы переключаться между агентами Build, Plan и Compose",
  "tui.tips.theme_mode":
    "Выполните {highlight}/dark{/highlight} для тёмного режима или {highlight}/light{/highlight} для светлого",
  "tui.tips.doc": "Выполните {highlight}/doc{/highlight}, чтобы открыть пользовательскую документацию",
  "tui.tips.free_models": "Бесплатные модели доступны ограниченное время — попробуйте их сейчас!",
  "tui.tips.background":
    "Выполните {highlight}/background{/highlight}, чтобы установить произвольное изображение в качестве фона главной страницы",
  "tui.tips.undo":
    "Используйте {highlight}/undo{/highlight}, чтобы отменить последнее сообщение и изменения файлов",
  "tui.tips.redo":
    "Используйте {highlight}/redo{/highlight}, чтобы вернуть ранее отменённые сообщения и изменения",
  "tui.tips.share":
    "Выполните {highlight}/share{/highlight}, чтобы получить публичную ссылку на диалог на opencode.ai",
  "tui.tips.drag_drop": "Перетащите изображения или PDF в терминал, чтобы добавить их в контекст",
  "tui.tips.paste_image":
    "Нажмите {highlight}Ctrl+V{/highlight}, чтобы вставить изображение из буфера обмена в строку ввода",
  "tui.tips.editor":
    "Нажмите {highlight}Ctrl+X E{/highlight} или {highlight}/editor{/highlight}, чтобы редактировать сообщения во внешнем редакторе",
  "tui.tips.init":
    "Выполните {highlight}/init{/highlight}, чтобы автоматически сгенерировать правила проекта по вашему коду",
  "tui.tips.models":
    "Выполните {highlight}/models{/highlight} или {highlight}Ctrl+X M{/highlight}, чтобы переключаться между моделями",
  "tui.tips.theme":
    "Используйте {highlight}/themes{/highlight} или {highlight}Ctrl+X T{/highlight}, чтобы переключаться между {{count}} встроенными темами",
  "tui.tips.new_session":
    "Нажмите {highlight}Ctrl+X N{/highlight} или {highlight}/new{/highlight}, чтобы начать новую сессию",
  "tui.tips.sessions":
    "Используйте {highlight}/sessions{/highlight} или {highlight}Ctrl+X L{/highlight}, чтобы просмотреть и продолжить предыдущие сессии",
  "tui.tips.compact":
    "Выполните {highlight}/compact{/highlight}, чтобы сжимать длинные сессии у границы контекста",
  "tui.tips.export":
    "Нажмите {highlight}Ctrl+X X{/highlight} или {highlight}/export{/highlight}, чтобы сохранить диалог в Markdown",
  "tui.tips.copy_last":
    "Нажмите {highlight}Ctrl+X Y{/highlight}, чтобы скопировать последнее сообщение ассистента",
  "tui.tips.command_palette":
    "Нажмите {highlight}Ctrl+P{/highlight}, чтобы посмотреть все доступные действия и команды",
  "tui.tips.login":
    "Выполните {highlight}/login{/highlight}, чтобы войти и использовать ваш тарифный план токенов",
  "tui.tips.connect":
    "Выполните {highlight}/connect{/highlight}, чтобы выбрать LLM-провайдера и добавить API-ключи",
  "tui.tips.leader":
    "Лидер-клавиша — {highlight}Ctrl+X{/highlight}; сочетайте её с другими клавишами для быстрых действий",
  "tui.tips.f2": "Нажмите {highlight}F2{/highlight}, чтобы быстро переключаться между недавно используемыми моделями",
  "tui.tips.sidebar": "Нажмите {highlight}Ctrl+X B{/highlight}, чтобы показать или скрыть боковую панель",
  "tui.tips.history":
    "Используйте {highlight}PageUp{/highlight}/{highlight}PageDown{/highlight} для перемещения по истории диалога",
  "tui.tips.jump_first":
    "Нажмите {highlight}Ctrl+G{/highlight} или {highlight}Home{/highlight}, чтобы перейти в начало диалога",
  "tui.tips.jump_last":
    "Нажмите {highlight}Ctrl+Alt+G{/highlight} или {highlight}End{/highlight}, чтобы перейти к последнему сообщению",
  "tui.tips.newline":
    "Нажмите {highlight}Shift+Enter{/highlight} или {highlight}Ctrl+J{/highlight}, чтобы добавить перенос строки во ввод",
  "tui.tips.clear_input":
    "Нажмите {highlight}Ctrl+C{/highlight} во время ввода, чтобы очистить поле ввода",
  "tui.tips.escape":
    "Нажмите {highlight}Escape{/highlight}, чтобы прервать ИИ во время ответа",
  "tui.tips.plan_agent":
    "Переключитесь на агента {highlight}Plan{/highlight}, чтобы получать предложения без реальных изменений",
  "tui.tips.subagent":
    "Используйте {highlight}@agent-name{/highlight} в подсказках, чтобы вызывать специализированных под-агентов",
  "tui.tips.cycle_sessions":
    "Нажимайте {highlight}Ctrl+X Right/Left{/highlight}, чтобы переключаться между родительской и дочерними сессиями",
  "tui.tips.config_files":
    "Создайте {highlight}mimocode.json{/highlight} для серверных настроек и {highlight}tui.json{/highlight} для настроек TUI",
  "tui.tips.global_config":
    "Поместите настройки TUI в {highlight}~/.config/mimocode/tui.json{/highlight} как глобальные",
  "tui.tips.schema":
    "Добавьте {highlight}$schema{/highlight} в конфиг для автодополнения в редакторе",
  "tui.tips.default_model":
    "Задайте {highlight}model{/highlight} в конфиге, чтобы установить модель по умолчанию",
  "tui.tips.keybinds":
    "Переопределяйте любые сочетания клавиш в {highlight}tui.json{/highlight} в разделе {highlight}keybinds{/highlight}",
  "tui.tips.disable_keybind":
    "Установите сочетание в {highlight}none{/highlight}, чтобы полностью его отключить",
  "tui.tips.mcp_config":
    "Настройте локальные или удалённые MCP-серверы в разделе {highlight}mcp{/highlight} конфига",
  "tui.tips.mcp_oauth":
    "MiMoCode автоматически обрабатывает OAuth для удалённых MCP-серверов с авторизацией",
  "tui.tips.custom_command":
    "Добавляйте файлы {highlight}.md{/highlight} в {highlight}.mimocode/command/{/highlight} для повторно используемых пользовательских команд",
  "tui.tips.command_args":
    "Используйте {highlight}$ARGUMENTS{/highlight}, {highlight}$1{/highlight}, {highlight}$2{/highlight} в командах для динамического ввода",
  "tui.tips.command_backticks":
    "Используйте обратные кавычки в командах, чтобы вставить вывод shell (например, {highlight}`git status`{/highlight})",
  "tui.tips.custom_agent":
    "Добавляйте файлы {highlight}.md{/highlight} в {highlight}.mimocode/agent/{/highlight} для специализированных AI-персон",
  "tui.tips.agent_perms":
    "Настройте для каждого агента отдельные права на инструменты {highlight}edit{/highlight}, {highlight}bash{/highlight} и {highlight}webfetch{/highlight}",
  "tui.tips.bash_allow":
    'Используйте шаблоны вроде {highlight}"git *": "allow"{/highlight} для тонких bash-разрешений',
  "tui.tips.bash_deny":
    'Установите {highlight}"rm -rf *": "deny"{/highlight}, чтобы блокировать разрушительные команды',
  "tui.tips.bash_ask":
    'Настройте {highlight}"git push": "ask"{/highlight}, чтобы запрашивать подтверждение перед push',
  "tui.tips.formatter":
    "MiMoCode автоматически форматирует файлы с помощью prettier, gofmt, ruff и других инструментов",
  "tui.tips.disable_formatter":
    'Установите {highlight}"formatter": false{/highlight}, чтобы отключить всё авто-форматирование',
  "tui.tips.custom_formatter":
    "Определяйте собственные команды форматирования по расширениям файлов в конфиге",
  "tui.tips.lsp": "MiMoCode использует LSP-серверы для интеллектуального анализа кода",
  "tui.tips.custom_tool":
    "Создавайте файлы {highlight}.ts{/highlight} в {highlight}.mimocode/tools/{/highlight}, чтобы определить новые LLM-инструменты",
  "tui.tips.tool_scripts":
    "Определения инструментов могут вызывать скрипты на Python, Go и других языках",
  "tui.tips.plugins":
    "Добавляйте файлы {highlight}.ts{/highlight} в {highlight}.mimocode/plugin/{/highlight} для подключения хуков событий",
  "tui.tips.plugin_notify":
    "Используйте плагины, чтобы отправлять системные уведомления при завершении сессий",
  "tui.tips.plugin_protect":
    "Создайте плагин, который запретит MiMoCode читать чувствительные файлы",
  "tui.tips.run":
    "Используйте {highlight}mimo run{/highlight} для неинтерактивных скриптов",
  "tui.tips.continue":
    "Используйте {highlight}mimo --continue{/highlight}, чтобы продолжить последнюю сессию",
  "tui.tips.attach_cli":
    "Используйте {highlight}mimo run -f file.ts{/highlight}, чтобы прикрепить файлы из командной строки",
  "tui.tips.format_json":
    "Используйте {highlight}--format json{/highlight} для машинно-читаемого вывода в скриптах",
  "tui.tips.serve":
    "Запустите {highlight}mimo serve{/highlight} для headless-доступа к API MiMoCode",
  "tui.tips.attach_server":
    "Используйте {highlight}mimo run --attach{/highlight}, чтобы подключиться к запущенному серверу",
  "tui.tips.upgrade":
    "Выполните {highlight}mimo upgrade{/highlight}, чтобы обновиться до последней версии",
  "tui.tips.auth_list":
    "Выполните {highlight}mimo auth list{/highlight}, чтобы увидеть всех настроенных провайдеров",
  "tui.tips.agent_create":
    "Выполните {highlight}mimo agent create{/highlight}, чтобы создать агента в пошаговом режиме",
  "tui.tips.github_trigger":
    "Используйте {highlight}/opencode{/highlight} в issue/PR на GitHub, чтобы запускать AI-действия",
  "tui.tips.github_install":
    "Выполните {highlight}mimo github install{/highlight}, чтобы настроить GitHub-workflow",
  "tui.tips.github_oc":
    "Оставьте {highlight}/oc{/highlight} в комментарии к строке PR для точечного код-ревью",
  "tui.tips.theme_system":
    'Используйте {highlight}"theme": "system"{/highlight}, чтобы соответствовать цветам терминала',
  "tui.tips.theme_files":
    "Создавайте JSON-файлы тем в каталоге {highlight}.mimocode/themes/{/highlight}",
  "tui.tips.theme_variants":
    "Темы поддерживают тёмные и светлые варианты для обоих режимов",
  "tui.tips.theme_ansi": "Ссылайтесь на ANSI-цвета 0-255 в собственных темах",
  "tui.tips.env_var":
    "Используйте синтаксис {highlight}{env:VAR_NAME}{/highlight} для ссылки на переменные окружения в конфиге",
  "tui.tips.file_var":
    "Используйте {highlight}{file:path}{/highlight}, чтобы вставлять содержимое файла в значения конфига",
  "tui.tips.instructions":
    "Используйте {highlight}instructions{/highlight} в конфиге, чтобы подключать дополнительные файлы правил",
  "tui.tips.temperature":
    "Устанавливайте {highlight}temperature{/highlight} агента от 0.0 (сосредоточенно) до 1.0 (творчески)",
  "tui.tips.steps":
    "Настройте {highlight}steps{/highlight}, чтобы ограничить число агентских итераций на запрос",
  "tui.tips.disable_tool":
    'Установите {highlight}"tools": {"bash": false}{/highlight}, чтобы отключить отдельные инструменты',
  "tui.tips.disable_mcp_tools":
    'Установите {highlight}"mcp_*": false{/highlight}, чтобы отключить все инструменты конкретного MCP-сервера',
  "tui.tips.tool_override":
    "Переопределяйте глобальные настройки инструментов в конфигурации каждого агента",
  "tui.tips.share_auto":
    'Установите {highlight}"share": "auto"{/highlight}, чтобы автоматически делиться всеми сессиями',
  "tui.tips.share_disabled":
    'Установите {highlight}"share": "disabled"{/highlight}, чтобы запретить любой шаринг сессий',
  "tui.tips.unshare":
    "Выполните {highlight}/unshare{/highlight}, чтобы убрать сессию из публичного доступа",
  "tui.tips.doom_loop":
    "Разрешение {highlight}doom_loop{/highlight} предотвращает бесконечные циклы вызова инструментов",
  "tui.tips.external_dir":
    "Разрешение {highlight}external_directory{/highlight} защищает файлы вне проекта",
  "tui.tips.debug_config":
    "Выполните {highlight}mimo debug config{/highlight}, чтобы диагностировать проблемы конфигурации",
  "tui.tips.print_logs":
    "Используйте флаг {highlight}--print-logs{/highlight}, чтобы видеть подробные логи в stderr",
  "tui.tips.timeline":
    "Нажмите {highlight}Ctrl+X G{/highlight} или {highlight}/timeline{/highlight}, чтобы перейти к нужному сообщению",
  "tui.tips.toggle_code":
    "Нажмите {highlight}Ctrl+X H{/highlight}, чтобы переключать видимость блоков кода в сообщениях",
  "tui.tips.status":
    "Нажмите {highlight}Ctrl+X S{/highlight} или {highlight}/status{/highlight}, чтобы посмотреть статус системы",
  "tui.tips.scroll_accel":
    "Включите {highlight}scroll_acceleration{/highlight} в {highlight}tui.json{/highlight} для плавной прокрутки",
  "tui.tips.username_toggle":
    "Переключайте отображение имени пользователя через палитру команд ({highlight}Ctrl+P{/highlight})",
  "tui.tips.docker":
    "Выполните {highlight}docker run -it --rm ghcr.io/anomalyco/opencode{/highlight} для контейнерного запуска",
  "tui.tips.zen":
    "Используйте {highlight}/connect{/highlight} с MiMo Code для подобранных и протестированных моделей",
  "tui.tips.agents_md":
    "Закоммитьте {highlight}AGENTS.md{/highlight} вашего проекта в Git для общего доступа в команде",
  "tui.tips.review":
    "Используйте {highlight}/review{/highlight} для ревью незакоммиченных изменений, веток или PR",
  "tui.tips.help":
    "Выполните {highlight}/help{/highlight} или {highlight}Ctrl+X H{/highlight}, чтобы открыть справку",
  "tui.tips.rename":
    "Используйте {highlight}/rename{/highlight}, чтобы переименовать текущую сессию",
  "tui.tips.suspend.unix":
    "Нажмите {highlight}Ctrl+Z{/highlight}, чтобы приостановить терминал и вернуться в shell",
  "tui.tips.suspend.win":
    "Нажмите {highlight}Ctrl+Z{/highlight}, чтобы отменить изменения в строке ввода",

  // Command palette UI
  "tui.command.palette.title": "Команды",
  "tui.command.palette.suggested": "Рекомендуемые",

  // Command categories
  "tui.command.category.session": "Сессия",
  "tui.command.category.agent": "Агент",
  "tui.command.category.provider": "Провайдер",
  "tui.command.category.system": "Система",
  "tui.command.category.prompt": "Ввод",
  "tui.command.category.internal": "Внутренние",
  "tui.command.category.external": "Внешние",

  // Built-in slash command descriptions
  "tui.slash.init.description": "пошаговая настройка AGENTS.md",
  "tui.slash.review.description": "просмотр изменений [commit|branch|pr], по умолчанию незакоммиченные",
  "tui.slash.dream.description":
    "вручную консолидировать память проекта из memory-файлов и сырой траектории",
  "tui.slash.distill.description":
    "найти повторяющиеся workflow в недавней работе и упаковать их в skills, субагентов или команды",
  "tui.slash.goal.description":
    "задать цель с условием остановки; выполняется, пока судья не подтвердит. /goal clear для отмены",
  "tui.slash.deep-research.description":
    "глубокий многоисточниковый проверенный отчёт (запускает workflow deep-research)",

  // Language switching
  "tui.command.language.switch.title": "Сменить язык",
  "tui.command.language.switch.description": "Изменить язык интерфейса",
  "tui.command.language.dialog.title": "Сменить язык",
  "tui.language.auto": "Авто (системный)",
  "tui.language.current": "Текущий",

  // App-level commands
  "tui.command.session.list.title": "Сменить сессию",
  "tui.command.session.new.title": "Новая сессия",
  "tui.command.workflow.list.title": "Рабочие процессы",
  "tui.command.model.list.title": "Сменить модель",
  "tui.command.model.cycle_recent.title": "Цикл моделей",
  "tui.command.model.cycle_recent_reverse.title": "Цикл моделей (в обратном порядке)",
  "tui.command.model.cycle_favorite.title": "Цикл избранных моделей",
  "tui.command.model.cycle_favorite_reverse.title": "Цикл избранных моделей (в обратном порядке)",
  "tui.command.agent.list.title": "Сменить агента",
  "tui.command.mcp.list.title": "Переключить MCP",
  "tui.command.never_ask.title_on": "Без вопросов: ВКЛ (авто-решение, кроме запросов разрешений) — нажмите для выключения",
  "tui.command.never_ask.title_off": "Без вопросов: ВЫКЛ — нажмите для включения (авто-решение, кроме запросов разрешений)",
  "tui.command.never_ask.toast_on":
    "Без вопросов ВКЛ — я не буду спрашивать; сам выберу лучший вариант, пока вы не выключите (/never-ask). Запросы разрешений по-прежнему требуют вашего подтверждения.",
  "tui.command.never_ask.toast_off": "Без вопросов ВЫКЛ — я снова буду спрашивать вас в точках принятия решений.",
  "tui.command.agent.cycle.title": "Цикл агентов",
  "tui.command.variant.cycle.title": "Цикл вариантов",
  "tui.command.variant.list.title": "Сменить вариант модели",
  "tui.command.agent.cycle.reverse.title": "Цикл агентов (в обратном порядке)",
  "tui.command.provider.login.title": "Войти",
  "tui.command.provider.connect.title": "Подключить провайдера",
  "tui.command.provider.logout.title": "Выйти",
  "tui.command.console.org.switch.title": "Сменить организацию",
  "tui.command.opencode.status.title": "Посмотреть статус",
  "tui.command.theme.switch.title": "Сменить тему",
  "tui.command.logo.switch.title": "Сменить дизайн логотипа",
  "tui.dialog.logo.title": "Дизайн логотипа",
  "tui.dialog.logo.option.classic": "Классический (жирный)",
  "tui.dialog.logo.option.thin": "Тонкий (полублок)",
  "tui.command.theme.switch_mode.to_light": "Переключить на светлый режим",
  "tui.command.theme.switch_mode.to_dark": "Переключить на тёмный режим",
  "tui.command.theme.mode.unlock": "Разблокировать режим темы",
  "tui.command.theme.mode.lock": "Заблокировать режим темы",
  "tui.command.help.show.title": "Справка",
  "tui.dialog.help.close_hint": "esc/enter",
  "tui.dialog.help.command_list":
    "Нажмите {{keybind}}, чтобы увидеть все доступные действия и команды в любом контексте.",
  "tui.dialog.help.ok": "OK",
  "tui.dialog.close_hint": "esc",
  "tui.dialog.ok": "OK",
  "tui.dialog.confirm.cancel": "Отмена",
  "tui.dialog.confirm.confirm": "Подтвердить",
  "tui.dialog.agreement.title": "Условия и конфиденциальность",
  "tui.dialog.agreement.message": "Ознакомьтесь и примите их, чтобы продолжить.",
  "tui.dialog.agreement.confirm": "Принять и продолжить",
  "tui.command.consent.revoke.title": "Отозвать согласие на бесплатную модель",
  "tui.consent.revoked": "Согласие на бесплатную модель отозвано — потребуется принять снова",
  "tui.dialog.select.placeholder": "Поиск",
  "tui.dialog.select.no_results": "Ничего не найдено",
  "tui.dialog.prompt.placeholder": "Введите текст",
  "tui.dialog.prompt.busy": "Выполняется...",
  "tui.dialog.prompt.processing": "обработка...",
  "tui.dialog.prompt.submit_key": "enter",
  "tui.dialog.prompt.submit_action": "отправить",
  "tui.dialog.export.title": "Параметры экспорта",
  "tui.dialog.export.filename": "Имя файла:",
  "tui.dialog.export.filename_placeholder": "Введите имя файла",
  "tui.dialog.export.include_thinking": "Включить рассуждения",
  "tui.dialog.export.include_tool_details": "Включить детали инструментов",
  "tui.dialog.export.include_assistant_metadata": "Включить метаданные ассистента",
  "tui.dialog.export.open_without_saving": "Открыть без сохранения",
  "tui.dialog.export.hint.toggle_prefix": "Нажмите",
  "tui.dialog.export.hint.toggle_action": "для переключения",
  "tui.dialog.export.hint.confirm_action": "для подтверждения",
  "tui.dialog.export.hint.options_action": "для параметров",
  "tui.toast.copied_to_clipboard": "Скопировано в буфер обмена",
  "tui.toast.instructions_loaded": "Загружено {{files}}",
  "tui.toast.update_available.title": "Доступно обновление",
  "tui.toast.update_available.confirm": "Доступна новая версия v{{version}}. Обновить сейчас?",
  "tui.toast.update_available.updating": "Обновление до v{{version}}...",
  "tui.toast.update_available.failed": "Не удалось обновить",
  "tui.toast.update_available.success": "Обновлено до MiMoCode v{{version}}. Пожалуйста, перезапустите приложение.",
  "tui.toast.updated.title": "Автообновление выполнено",
  "tui.toast.updated.message": "Патч применён автоматически: v{{version}}. Перезапустите для использования новой версии. Отключите через autoupdate: false в конфигурации.",
  "tui.sidebar.instructions": "Инструкции",
  "tui.sidebar.cwd": "Рабочий каталог",
  "tui.toast.unknown_error": "Произошла неизвестная ошибка",
  "tui.command.docs.open.title": "Открыть документацию",
  "tui.command.app.exit.title": "Выйти из приложения",
  "tui.command.app.debug.title": "Переключить панель отладки",
  "tui.command.app.console.title": "Переключить консоль",
  "tui.command.app.heap_snapshot.title": "Сохранить снимок кучи",
  "tui.command.terminal.suspend.title": "Приостановить терминал",
  "tui.command.terminal.title.disable": "Отключить заголовок терминала",
  "tui.command.terminal.title.enable": "Включить заголовок терминала",
  "tui.command.app.toggle.animations.disable": "Отключить анимации",
  "tui.command.app.toggle.animations.enable": "Включить анимации",
  "tui.command.app.toggle.diffwrap.disable": "Отключить перенос строк в diff",
  "tui.command.app.toggle.diffwrap.enable": "Включить перенос строк в diff",
  "tui.command.logout.toast": "Вы вышли из аккаунта",

  // Session-level commands
  "tui.command.session.share.title": "Поделиться сессией",
  "tui.command.session.share.copy_link": "Скопировать ссылку",
  "tui.command.session.rename.title": "Переименовать сессию",
  "tui.command.session.timeline.title": "Перейти к сообщению",
  "tui.command.session.fork.title": "Разветвить сессию",
  "tui.command.session.compact.title": "Сжать сессию",
  "tui.command.session.unshare.title": "Отменить публикацию",
  "tui.command.session.undo.title": "Отменить предыдущее сообщение",
  "tui.command.session.redo.title": "Повторить",
  "tui.command.session.sidebar.show": "Показать боковую панель",
  "tui.command.session.sidebar.hide": "Скрыть боковую панель",
  "tui.command.session.conceal.disable": "Отключить скрытие кода",
  "tui.command.session.conceal.enable": "Включить скрытие кода",
  "tui.command.session.timestamps.show": "Показать метки времени",
  "tui.command.session.timestamps.hide": "Скрыть метки времени",
  "tui.command.session.thinking.expand": "Развернуть рассуждения",
  "tui.command.session.thinking.collapse": "Свернуть рассуждения",
  "tui.command.session.tool_details.show": "Показать детали инструментов",
  "tui.command.session.tool_details.hide": "Скрыть детали инструментов",
  "tui.command.session.scrollbar.toggle": "Переключить полосу прокрутки",
  "tui.command.session.generic_tool_output.show": "Показать общий вывод инструментов",
  "tui.command.session.generic_tool_output.hide": "Скрыть общий вывод инструментов",
  "tui.command.session.page_up.title": "Страница вверх",
  "tui.command.session.page_down.title": "Страница вниз",
  "tui.command.session.line_up.title": "Строка вверх",
  "tui.command.session.line_down.title": "Строка вниз",
  "tui.command.session.half_page_up.title": "Полстраницы вверх",
  "tui.command.session.half_page_down.title": "Полстраницы вниз",
  "tui.command.session.first.title": "Первое сообщение",
  "tui.command.session.last.title": "Последнее сообщение",
  "tui.command.session.last_user.title": "К последнему сообщению пользователя",
  "tui.command.session.message_next.title": "Следующее сообщение",
  "tui.command.session.message_previous.title": "Предыдущее сообщение",
  "tui.command.messages.copy.title": "Скопировать последнее сообщение ассистента",
  "tui.command.session.copy.title": "Скопировать стенограмму сессии",
  "tui.command.session.export.title": "Экспортировать стенограмму",
  "tui.command.session.child_first.title": "Перейти в дочернюю сессию",
  "tui.command.session.parent.title": "Перейти в родительскую сессию",
  "tui.command.session.child_next.title": "Следующая дочерняя сессия",
  "tui.command.session.child_previous.title": "Предыдущая дочерняя сессия",

  // Prompt commands
  "tui.command.prompt.clear.title": "Очистить ввод",
  "tui.command.prompt.submit.title": "Отправить запрос",
  "tui.command.prompt.paste.title": "Вставить",
  "tui.command.session.interrupt.title": "Прервать сессию",
  "tui.command.prompt.editor.title": "Открыть редактор",
  "tui.command.prompt.skills.title": "Навыки",
  "tui.command.voice.toggle.title": "Переключить голосовой ввод",
  "tui.command.voice.toggle.title_on": "Голосовой ввод: включён — нажмите для отключения",
  "tui.command.voice.toggle.title_off": "Голосовой ввод: отключён — нажмите для включения",
  "tui.voice.enabled": "Голосовой ввод включён (китайский/английский) — нажмите [Voice] для записи",
  "tui.voice.disabled": "Голосовой ввод отключён",
  "tui.voice.send.enabled": "Голосовая отправка включена — скажите「发送」или \"send it\"",
  "tui.voice.send.disabled": "Голосовая отправка отключена",
  "tui.voice.control.enabled": "Голосовое управление включено — интеллектуальное редактирование с мультимодальной моделью (медленнее)",
  "tui.voice.control.disabled": "Голосовое управление отключено — используется быстрая ASR транскрипция",
  "tui.command.voice.control.title": "Переключить голосовое управление (мультимодальное)",
  "tui.command.voice.control.title_on": "Голосовое управление: включено (мультимодальное) — нажмите для отключения",
  "tui.command.voice.control.title_off": "Голосовое управление: отключено (быстрый ASR) — нажмите для включения",
  "tui.voice.error.no_auth": "Используйте /connect для подключения к MiMo или настройте voice.asr_model для другого провайдера",
  "tui.voice.error.no_auth_provider": "Голосовой провайдер \"{{provider}}\" не авторизован, проверьте его apiKey",
  "tui.voice.error.provider_not_found": "Провайдер \"{{provider}}\" недоступен — /connect для аутентификации, или объявите models в конфигурации для пользовательских эндпоинтов",
  "tui.voice.error.no_url": "У провайдера \"{{provider}}\" не настроен baseURL — укажите options.baseURL в конфигурации",
  "tui.voice.error.no_device": "Микрофон/аудиоустройство не найдено — проверьте настройки звука системы",
  "tui.voice.error.recorder_failed": "Ошибка записи",
  "tui.voice.error.no_recorder": "Инструмент записи не найден, установите sox",
  "tui.voice.error.too_short": "Запись слишком короткая",
  "tui.voice.error.network": "Ошибка транскрипции, проверьте сеть",
  "tui.command.prompt.stash.title": "Сохранить ввод во временное хранилище",
  "tui.command.prompt.stash.pop.title": "Восстановить из хранилища",
  "tui.command.prompt.stash.list.title": "Список временных запросов",

  // Tips toggle / Plugins
  "tui.command.tips.toggle.show": "Показать подсказки",
  "tui.command.tips.toggle.hide": "Скрыть подсказки",
  "tui.command.plugins.list.title": "Плагины",
  "tui.command.plugins.install.title": "Установить плагин",

  // MiMo Auto (free) — TUI login dialog
  "tui.dialog.login.mimo_free": "MiMo Auto (free)",
  "tui.dialog.login.mimo_free.desc": "Анонимный бесплатный канал — вход не требуется",
  "tui.dialog.login.mimo_free.success": "MiMo Auto (free) готов — модель по умолчанию: mimo/mimo-auto",
  "tui.dialog.login.mimo_free.unavailable": "Провайдер MiMo Auto (free) не загружен",
  "tui.dialog.login.flow.title": "Вход в MiMo",
  "tui.dialog.login.flow.placeholder": "Вставьте код (или дождитесь обратного вызова браузера)",
  "tui.dialog.login.flow.busy": "Вход...",
  "tui.dialog.login.flow.manual_hint": "Браузер не открылся? Нажмите на ссылку ниже, чтобы скопировать:",
  "tui.dialog.login.flow.waiting": "Ожидание авторизации в браузере...",
  "tui.dialog.login.flow.invalid_code": "Неверный код, попробуйте ещё раз",
  "tui.dialog.login.flow.copied": "Скопировано",

  // CLI: providers command (auth login)
  "cli.providers.select": "Выберите провайдера",
  "cli.providers.other": "Другой провайдер",
  "cli.providers.mimo.recommended_hint": "рекомендуется",
  "cli.providers.mimo_free.hint": "Анонимный бесплатный канал / mimo-auto",
  "cli.providers.mimo_free.verifying": "Проверка канала MiMo Auto (free)...",
  "cli.providers.mimo_free.ready": "Канал MiMo Auto (free) готов",
  "cli.providers.mimo_free.failed": "Не удалось проверить MiMo Auto (free)",
  "cli.providers.mimo_free.default_set": "Модель по умолчанию: mimo/mimo-auto (контекст 1M, бесплатно)",
  "cli.providers.mimo_free.usage_hint":
    "Вход не требуется — просто запустите mimo. Для платных/премиум-моделей выберите вход через браузер MiMo.",
  "cli.providers.mimo_login.decrypt_retry": "Ошибка расшифровки, повторите попытку (осталось попыток: {remaining})",
  "cli.providers.mimo_login.decrypt_exhausted": "Ошибка расшифровки, превышено максимальное число попыток",

  // Question i18n — plan_exit
  "tui.question.plan_exit.question": "План {{plan}} завершён. Переключиться на агента build и начать реализацию?",
  "tui.question.plan_exit.header": "Выход из плана",
  "tui.question.plan_exit.option.0.label": "Да",
  "tui.question.plan_exit.option.0.description": "Переключиться на агента build и начать реализацию плана",
  "tui.question.plan_exit.option.1.label": "Нет",
  "tui.question.plan_exit.option.1.description": "Остаться с агентом plan для доработки плана",

  // Session badges
  "tui.session.badge.auto": "Авто",

  // Workspace trust
  "trust.title": "Доступ к рабочему пространству:",
  "trust.safety_check": "Проверка безопасности: это проект, который вы создали или которому доверяете? (Ваш собственный код, известный open source проект или работа вашей команды). Если нет, сначала проверьте содержимое этой папки.",
  "trust.capabilities": "MiMo Code сможет читать, редактировать и выполнять файлы здесь.",
  "trust.plugin_warn": "Если в этом каталоге есть вредоносные плагины, они могут выполнять произвольный код, читать, изменять или похищать ваши файлы.",
  "trust.option.yes": "Да, я доверяю этой папке",
  "trust.option.no": "Нет, выйти",
  "trust.dangerous.title_home": "ВНИМАНИЕ: Вы собираетесь открыть ДОМАШНИЙ КАТАЛОГ.",
  "trust.dangerous.title_root": "ВНИМАНИЕ: Вы собираетесь открыть КОРЕНЬ ФАЙЛОВОЙ СИСТЕМЫ.",
  "trust.dangerous.body_home": "Модель получит доступ ко ВСЕМ вашим личным файлам — SSH-ключам, учётным данным, профилям браузера и всему содержимому домашней папки.",
  "trust.dangerous.body_root": "Модель получит доступ ко ВСЕЙ файловой системе — системным файлам, данным всех пользователей, учётным данным и всему на этой машине.",
  "trust.dangerous.advice_home": "Если нет весомой причины, НЕ доверяйте всему домашнему каталогу.",
  "trust.dangerous.advice_root": "Если нет весомой причины, НЕ доверяйте корню файловой системы.",
  "trust.dangerous.option.yes": "Я понимаю риски, доверять только в этой сессии",
  "trust.dangerous.option.no": "Выйти (рекомендуется)",
} satisfies Partial<Record<Keys, string>>
