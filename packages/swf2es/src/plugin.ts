// dist/plugin.js, a classic script: Flash's plug-in listed in navigator as
// the page reads its <script src>, before the page's next scripts look for
// Flash. A module, swf2es.js among them, runs only once the page has been
// read, after any such script.
import { installFlashPlugin } from "@swf2es/web/plugin";

installFlashPlugin();
