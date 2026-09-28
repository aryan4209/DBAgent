import { serverlessHandler, startServer } from "./webApp.ts";

// Vercel invokes the default export per request, so only listen when running as a normal server.
export default serverlessHandler;

if (!process.env.VERCEL) {
  const server = await startServer();

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}
