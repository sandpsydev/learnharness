import { element, request } from "./ui";
import { errorMessage } from "./types";
import type { Config } from "./types";
const field = (id: string) => element<HTMLInputElement>(id);
const say = (text: string) => { element("notice").textContent = text; };
void request<Config>({ type: "config" }).then((config) => {
  field("app-url").value = config.appUrl; field("expert-url").value = config.expertUrl; field("token").value = config.token;
}).catch((error) => say(errorMessage(error)));
element("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void request({ type: "save-config", config: { appUrl: field("app-url").value, expertUrl: field("expert-url").value, token: field("token").value } })
    .then(() => say("Settings saved. Test the connection before opening the queue."), (error) => say(errorMessage(error)));
});
element("test").addEventListener("click", () => void request({ type: "ping" }).then(() => say("LearnHarness is running and paired (API v1)."), (error) => say(errorMessage(error))));
