import { element, request } from "./ui";
import { errorMessage } from "./types";
import type { Config } from "./types";
const field = (id: string) => element<HTMLInputElement>(id);
const say = (text: string) => { element("notice").textContent = text; };
void request<Config>({ type: "config" }).then((config) => {
  field("automatic").checked = config.automatic !== false;
  field("app-url").value = config.appUrl; field("expert-url").value = config.expertUrl; field("token").value = config.token;
}).catch((error) => say(errorMessage(error)));
element("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void request({ type: "save-config", config: { appUrl: field("app-url").value, expertUrl: field("expert-url").value, token: field("token").value, automatic: field("automatic").checked } })
    .then(() => say("Settings saved. Automatic mode resumes if enabled; uncertain submissions still need manual review."), (error) => say(errorMessage(error)));
});
element("test").addEventListener("click", () => void request({ type: "ping" }).then(() => say("LearnHarness is running and paired (API v1)."), (error) => say(errorMessage(error))));
