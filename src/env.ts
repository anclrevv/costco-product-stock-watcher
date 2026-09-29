export type AppEnv = Env &
  Readonly<{
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TG_WEBHOOK_SECRET: string;
    ADMIN_TOKEN: string;
  }>;
