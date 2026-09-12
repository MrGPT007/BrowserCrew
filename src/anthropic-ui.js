installAnthropicProviderChoice();

function installAnthropicProviderChoice() {
  const grid = document.querySelector(".provider-grid");
  if (!grid || grid.querySelector('[data-provider="anthropic"]')) return;

  const button = document.createElement("button");
  button.className = "provider-card tactile";
  button.type = "button";
  button.dataset.provider = "anthropic";
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", "false");
  button.innerHTML = "<strong>Anthropic API</strong><span>Cloud · Claude models</span>";

  const openAI = grid.querySelector('[data-provider="openai"]');
  if (openAI) openAI.insertAdjacentElement("afterend", button);
  else grid.prepend(button);

  const modelHelp = document.querySelector("#modelInput + .helper");
  if (modelHelp) {
    modelHelp.innerHTML = "This is the model BrowserCrew asks to do the job. Example: <code>gpt-5.6</code> for OpenAI, <code>claude-sonnet-5</code> for Anthropic, or the exact model name loaded in LM Studio.";
  }

  const serverInput = document.querySelector("#serverInput");
  const example = serverInput?.parentElement?.querySelector(".example-box") || serverInput?.nextElementSibling?.nextElementSibling;
  if (example?.classList?.contains("example-box") && !example.textContent.includes("Anthropic")) {
    example.innerHTML = "📌 Examples: OpenAI → <code>https://api.openai.com/v1</code> · Anthropic → <code>https://api.anthropic.com/v1</code> · LM Studio → <code>http://127.0.0.1:1234/v1</code> · Ollama → <code>http://127.0.0.1:11434/v1</code>";
  }
}
