import { startServer } from "./webApp.ts";

const server = await startServer();

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
