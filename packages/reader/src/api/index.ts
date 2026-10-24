import { Hono } from "hono";

// Ponder requires an API entry point. B1 defines no read endpoints; Ponder still serves /health and /ready.
const app = new Hono();

export default app;
