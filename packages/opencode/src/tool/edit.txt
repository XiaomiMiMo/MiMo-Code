Performs exact string replacements in files.

Usage:
- You must use your `Read` tool at least once in the conversation before editing — this tool will error with a recoverable failure if you attempt an edit on a file that has not been Read in this session. Creating a brand-new file with `old_string=""` is exempt.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not found in the file with an error "old_string not found in content".
- The edit will FAIL if `old_string` is found multiple times in the file with an error "Found multiple matches for old_string. Provide more surrounding lines in old_string to identify the correct match." Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
