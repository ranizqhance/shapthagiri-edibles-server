import { Logger } from "@nestjs/common";

const nest = new Logger("App");

export const logger = {
  info: (msg: string, ctx?: any) => nest.log(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  log:  (msg: string, ctx?: any) => nest.log(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  warn: (msg: string, ctx?: any) => nest.warn(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  error: (msg: string, ctx?: any) => nest.error(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  debug: (msg: string, ctx?: any) => nest.debug(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
};
