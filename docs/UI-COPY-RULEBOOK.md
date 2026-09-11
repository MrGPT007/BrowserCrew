# UI copy implementation guide

Source: the user's **GRANDMA-PROOF UI COPY RULEBOOK(1).md**, version 1.0. This is a concise implementation checklist; the original attachment remains authoritative. The exact source copy is pending restoration of the disconnected workspace.

Core test: a person unfamiliar with software should know what a control does, what happens when used or left unused, and whether they should choose it.

- Use plain words. Avoid “configure settings,” “enable functionality,” “advanced options,” “technical parameters,” “integration settings,” “API endpoint,” “initialize,” and other unexplained implementation language.
- Every setting: label, helper, consequence, recommendation, and a concrete example where useful.
- Checkboxes: explain both checked and unchecked behavior.
- Number fields: show units, valid range, low/medium/high examples and a recommended default with a reason.
- Dropdowns: explain each option and mark the recommended choice.
- Textareas: explain input format and steps, show an example, and provide load-example and clear controls.
- Risky actions: explain affected scope and values, risks, use/avoid conditions and a conservative default. Do not hide consequences behind a tooltip.
- Use progressive disclosure for detailed explanations. Keep the immediate outcome visible near the control.
- At least 16px between setting groups; native semantics, keyboard access, clear focus, readable text and no color-only meaning.
- Read copy aloud. Test with a nontechnical person before claiming the rulebook's human validation gate passes.

Applied examples: “AI server address,” “Test and save connection,” “Choose the pages to use,” “Fill these fields,” “I’ll take over,” and explicit autosave and data-sharing explanations.
