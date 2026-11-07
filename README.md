# Mumble

Mumble decreases the token cost of each PI-Desktop agent session.
It starts with each session. You do not start it.

Credit: Mumble uses code adapted from [github.com/JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) by Julius Brussee (Apache-2.0, see [NOTICE](NOTICE)). Mumble is not affiliated with Julius Brussee, and Julius Brussee does not endorse it.

## What it does

1. **The agent says less.** Before each turn, Mumble puts a voice section at the start of the system prompt. The default voice is `ste`: short answers in ASD-STE100 Simplified Technical English.
2. **The agent reads less.** Before the model reads a large tool result, Mumble shrinks it by its content type. The result keeps the errors, the unusual entries, the start, the end and a summary of each removed part.
3. **Nothing is lost.** Before Mumble shrinks a result, it writes the exact original to disk. The agent uses the `mumble_retrieve` tool to get all of it, a line range or the lines that match a regex. If Mumble cannot write the original, it does not shrink the result.
4. **Cost counter.** Mumble counts the tokens, the cache reads, the cost and the shrink savings of the session.

## Voices

| Voice | Rules | Prompt size |
| --- | --- | ---: |
| `ste` (default) | ASD-STE100: answer first, no filler, 20 words for each instruction, 25 words for each description, active voice, articles kept, no semicolons. | about 420 tokens |
| `mumble` | Terse: answer first, no filler, articles optional. | about 380 tokens |
| `ultra` | Most terse: fragments, each fact once. | about 235 tokens |
| `off` | No voice rules. Only the note about shrunk results stays. | about 85 tokens |

The voice text does not change from turn to turn, so the prompt cache stores it.

**Why `ste` is the default.** The `mumble` voice drops articles, and `ultra` writes fragments. That breaks STE rule 4.2 ("do not omit words") and rule 4.5 ("use an article"). The `ste` voice keeps only the cuts that STE permits.

To change the voice, use `/mumble <voice>` or write one of these in a message:

- "use mumble", "mumble mode on", "be brief"
- "stop mumble", "stop mumbling", "normal mode"

A question about mumble or a negated request ("don't use mumble") does not change the voice.

## Shrunk tool results

| Content | What stays | Test sample |
| --- | --- | ---: |
| Logs | The first 2 lines, the last 2 lines, error and warning lines, stack lines, and lines with new words. Each removed run has a summary, for example `all status=200; range id=1002..1299`. | 40,159 → 543 characters |
| Terminal output | The text without color codes, the last state of each progress line, the first 3 lines, the last 3 lines and the failures. | 8,079 → 134 characters |
| CSV, TSV, Markdown tables | The header, the first 3 rows, the last 2 rows, the rows with errors and the minimum and maximum of each number column. | 7,007 → 283 characters |
| JSON | All keys and the structure. In each array longer than 8 items: the first 3 items, the last 2 items, items with errors and items with unusual numbers. Error and message fields stay complete. | 24,689 → 959 characters |
| Other text | Above 20,000 characters: the start and the end. For an error, more of the end. | |

The test samples are in [the tests](tests/mumble.test.mjs). Your results will be different.

Mumble shrinks only results above 3,000 characters. It does not shrink the results of Read, Edit, Write, Skill, Task, TaskWait, TodoWrite, asktool and `mumble_retrieve`. It does not shrink JSON with numbers that JavaScript cannot keep exactly, for example `12345678901234567890`.

## Commands

| Command | Result |
| --- | --- |
| `/mumble` | Shows the voice, the tokens, the cache hits, the cost and the shrink savings of this session. |
| `/mumble ste` | Sets the voice: `ste`, `mumble`, `ultra` or `off`. |
| `/mumble mode off` | Stops all changes. `mode on` starts them again. |
| `/mumble limit 30000` | Sets the limit for the start-and-end cut (2,000 to 200,000 characters). |

The commands write `pi-mumble/config.json` in `~/.config` (macOS, Linux) or `%APPDATA%` (Windows). In this file, you can also set `minChars` and `exempt` (the tool names that Mumble must not shrink).

## Permissions

- `agent.extension`: loads the agent module in each session.

Mumble makes no network requests and runs no programs. It writes the originals to `pi-mumble` in the temporary folder of your system. Only your user can read them. It removes them when the session ends.

## Limits

- The model decides how well it obeys the voice rules. Mumble does not check the replies.
- The counter is in memory. It starts at zero in each new session.
- The token values are estimates: 4 characters for each token.

## Tests

```sh
node --test tests/*.test.mjs
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
