// The URL dialog (static/open-url.html): a URL to open a remote SWF by,
// told the main process through window.swf2esPrompt. Only http and https.
export {};

declare global {
  interface Window {
    swf2esPrompt: {
      initial(): Promise<string>;
      answer(url: string | null): void;
    };
  }
}

const shell = window.swf2esPrompt;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("url") as HTMLInputElement;
const problem = document.getElementById("problem") as HTMLElement;

function remote(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!remote(input.value)) {
    problem.hidden = false;
    input.focus();
    return;
  }

  shell.answer(input.value.trim());
});
document.getElementById("cancel")?.addEventListener("click", () => shell.answer(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    shell.answer(null);
  }
});
input.addEventListener("input", () => {
  problem.hidden = true;
});

input.value = await shell.initial();
input.focus();
input.select();
