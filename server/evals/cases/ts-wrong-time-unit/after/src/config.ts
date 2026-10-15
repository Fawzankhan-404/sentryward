export const config = {
  port: Number(process.env.PORT ?? 3000),
  // How long a sign-in lasts, in seconds.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 24 * 60 * 60),
};
