# BrowserCrew UI Copy Rulebook

This repository uses the user-supplied **GRANDMA-PROOF UI COPY RULEBOOK v1.0** as a mandatory writing standard for every setting, checkbox, field, option, warning, and action.

## Core test

If an 80-year-old person who has never used this product cannot understand what will happen after clicking a control, the copy is not done.

Every configurable choice must answer:

1. **What does this do?** — plain language, no assumed technical knowledge.
2. **What happens if I choose it?** — a concrete result or consequence.
3. **Should I use it?** — a recommendation or safe default.
4. **What is a real example?** — show a realistic value or outcome when useful.

## Forbidden user-facing phrases

Do not ship vague labels such as: `Configure settings`, `Enable functionality`, `Advanced options`, `Technical parameters`, `Integration settings`, `API endpoint`, `Hook into system`, `Initialize component`, `Toggle feature flag`, or `Customize behavior`.

Technical terms may appear only after the plain-language explanation when the term helps troubleshooting. Example: prefer **“Where should BrowserCrew send the AI request?”** and then show the server address, rather than labeling the field **“API endpoint.”**

## Inputs

- **Checkbox/toggle:** label + one-sentence explanation + enabled outcome + disabled outcome + recommendation.
- **Number:** label with unit + what the number controls + low/high examples + recommended default + valid range.
- **Dropdown/radio choice:** what the choice controls + explain every option + mark the recommended option + warn about risky options.
- **Textarea/list:** format instruction + visible example + what the list does + how to use it + safe defaults/clear action when appropriate.
- **Dangerous action:** visible warning + what can go wrong + when to use + when not to use + conservative recommendation.

## BrowserCrew-specific examples

### Good connection copy

**AI model name**

“This is the model BrowserCrew asks to do the job. Example: `gpt-5.6` for OpenAI, or the exact model name loaded in LM Studio. Use a model that can follow instructions and return JSON. If the name is wrong, the connection test will tell you before a job starts.”

### Good server-address copy

**Where should BrowserCrew send the AI request?**

“This is the web address of your AI service. You usually do not need to change the preset.”

Examples: OpenAI → `https://api.openai.com/v1`; LM Studio → `http://127.0.0.1:1234/v1`; Ollama → `http://127.0.0.1:11434/v1`.

### Good secret copy

**Secret key for this AI service**

“BrowserCrew uses this key only to talk to the selected AI service. The key is kept in Chrome’s session storage and is not written into task history. Recommended: use a dedicated API key with spending limits. Local LM Studio and Ollama usually do not need a key.”

## Visual guidance

Use icons as reinforcement, never as the only explanation: ✅ positive result, ❌ blocked/negative result, 💡 recommendation, ⚠️ risk, 🔒 security, 📌 example, 📝 instructions.

Warnings need words, not only red/orange color. Status needs words, not only a colored light.

## Pre-merge copy checklist

- Can a non-technical user explain what every setting does without searching the web?
- Does every configurable choice explain the consequence?
- Is there a recommended/default path?
- Are risky options clearly warned?
- Are units and examples explicit?
- Are technical terms translated into normal language first?
- Does status remain understandable without color?

The static quality script enforces a small forbidden-phrase baseline. Human review remains required for meaning, examples, consequences, and recommendations.
