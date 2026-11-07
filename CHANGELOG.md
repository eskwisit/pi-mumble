# Changelog

## 0.1.0

- Add the voice section at the start of the system prompt. The default voice is `ste` (ASD-STE100). The other voices are `mumble`, `ultra` and `off`.
- Change the voice with `/mumble <voice>`, or with phrases such as "stop mumble" and "normal mode".
- Shrink large tool results by content type: JSON, logs, tables and terminal output. Cut other long text to its start and end.
- Keep the exact original of each shrunk result. Add the `mumble_retrieve` tool.
- Count the tokens, the cache reads, the cost and the shrink savings of each session. Add the `/mumble` command.
