// Local dev entry: start the forge on a fixed port so the conformance runner can reach it.
import { createApp } from './app.ts';
const port = Number(process.argv[2] ?? 9000);
createApp().listen(port, '127.0.0.1', () => console.log(`forge on ${port}`));
