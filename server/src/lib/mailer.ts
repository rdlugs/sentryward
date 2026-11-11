import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  // Sent with `text` as multipart/alternative; clients without HTML show the text.
  html?: string;
}

let transport: Transporter | undefined;

// Mail is optional: without SMTP_URL nothing is sent and callers fall back to
// showing the link. Held on an object so tests can replace `send` and never
// reach a real SMTP server.
export const mailer = {
  configured(): boolean {
    return Boolean(env.SMTP_URL);
  },

  async send(mail: Mail): Promise<void> {
    if (!env.SMTP_URL) {
      throw new Error("SMTP is not configured");
    }
    // Short timeouts so an unresponsive SMTP host fails fast and the callers'
    // fallbacks (createInvite still returns the link, resendInvite reports the
    // failure) are reached promptly instead of waiting on nodemailer's minutes.
    transport ??= nodemailer.createTransport({
      url: env.SMTP_URL,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  },
};
