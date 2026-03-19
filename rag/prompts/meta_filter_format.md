Additional metadata value format instructions:

- For each metadata key listed below, the generated `value` must follow its format instruction.
- A format instruction may be a regex or a plain-language pattern such as `<PREFIX> <NNN>/<YYYY>`.
- Apply a format instruction only to the matching metadata key.
- If the user's question does not provide enough information to produce a value that follows the format instruction, skip that condition.
- Never output the format instruction itself as the `value`.

Format instructions by key: {{ formats }}
