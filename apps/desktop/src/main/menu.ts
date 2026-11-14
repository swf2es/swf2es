// The application menu, built again as what plays and the settings change.
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { chooseLibrary, refuse, resetLibrary, showOpenDialog, showUrlDialog } from "./dialogs.ts";
import { closeMovie, current, openEntry } from "./open.ts";
import { settings, window } from "./state.ts";

export function buildMenu(): void {
  const recent = settings.settings.recent;
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "&File",
      submenu: [
        { label: "&Open…", accelerator: "CmdOrCtrl+O", click: () => void showOpenDialog() },
        { label: "Open &URL…", accelerator: "CmdOrCtrl+L", click: showUrlDialog },
        {
          label: "Open &Recent",
          submenu: [
            ...recent.map((entry) => ({ label: entry, click: () => void openEntry(entry) })),
            ...(recent.length > 0 ? [{ type: "separator" as const }] : []),
            {
              label: "Clear Recent",
              enabled: recent.length > 0,
              click: () => {
                settings.clearRecent();
                app.clearRecentDocuments();
                buildMenu();
              },
            },
          ],
        },
        {
          id: "close-movie",
          label: "&Close Movie",
          accelerator: "CmdOrCtrl+W",
          enabled: !!current,
          click: closeMovie,
        },
        { type: "separator" },
        { label: "Choose playerglobal.abc…", click: () => void chooseLibrary("playerglobal") },
        {
          label: "Use the App's playerglobal",
          enabled: !!settings.settings.playerglobal,
          click: () => resetLibrary("playerglobal"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          id: "reload-movie",
          label: "&Reload Movie",
          accelerator: "CmdOrCtrl+R",
          enabled: !!current,
          click: () => current && void openEntry(current.path),
        },
        { role: "togglefullscreen", accelerator: "F11" },
        { type: "separator" },
        {
          id: "stage3d",
          label: "Stage3D",
          type: "checkbox",
          checked: settings.stage3D,
          click: (item) => {
            if (!settings.setStage3D(item.checked)) {
              refuse(
                "The settings could not be saved.",
                "The Stage3D choice holds until you quit.",
              );
            }

            window?.webContents.reload();
          },
        },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
