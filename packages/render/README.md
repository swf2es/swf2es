# @swf2es/render

The renderer of [swf2es](https://github.com/swf2es/swf2es): what a frame
draws as typed arrays (shapes, bitmaps, text, filters, blend modes, masks),
the planner that turns it into commands, and a WebGL 2 backend at
`@swf2es/render/webgl`. The core uses no GPU and no DOM. The player
drives it ([`@swf2es/player`](https://www.npmjs.com/package/@swf2es/player),
`@swf2es/player/scene`); most pages want
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web).

```sh
npm install @swf2es/render
```

[docs/renderer.md](https://github.com/swf2es/swf2es/blob/main/docs/renderer.md)
describes its design.

Apache-2.0 ([LICENSE](LICENSE)).
