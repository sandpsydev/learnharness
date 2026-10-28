/// <reference types="chrome" />
// Chrome's offscreen clipboard pattern: execCommand works without focusing
// the hidden document. This document never loads or reads any external page.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "clipboard" || typeof message.text !== "string") return false;
  const area = document.querySelector<HTMLTextAreaElement>("#copy")!;
  area.value = message.text;
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } finally { area.value = ""; }
  respond({ ok });
  return false;
});
