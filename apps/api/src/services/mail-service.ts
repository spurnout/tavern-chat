import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

export interface SendOpts {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Thin abstraction over outbound transactional email. When SMTP_HOST is
 * configured, dispatches via nodemailer; otherwise logs the rendered body
 * to the structured logger so dev / air-gapped self-hosts can still see
 * what would have been sent (and follow the link out of the logs).
 *
 * Construct once at app bootstrap and pass to anything that needs to send
 * mail. The single-transporter design intentionally avoids per-request
 * connection setup; SMTP keep-alive is handled by nodemailer's pool option
 * if/when an operator wants higher throughput.
 */
export class MailService {
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {
    this.enabled = Boolean(config.SMTP_HOST);
    this.from = config.SMTP_FROM ?? this.defaultFrom();
    if (this.enabled && config.SMTP_HOST) {
      const authConfigured = Boolean(config.SMTP_USER && config.SMTP_PASS);
      this.transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        ...(authConfigured
          ? {
              auth: {
                user: config.SMTP_USER as string,
                pass: config.SMTP_PASS as string,
              },
            }
          : {}),
      });
    } else {
      this.transporter = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a mail. On the no-SMTP path, logs at info level so dev can copy
   * the reset link out of the terminal; on the SMTP path, dispatches via
   * nodemailer and logs at debug. Errors are caught and re-logged but
   * NOT re-thrown — callers must not let mail failures leak whether a
   * given address corresponds to an account.
   */
  async send(opts: SendOpts): Promise<void> {
    if (!this.transporter) {
      this.log.info(
        {
          event: 'mail.console',
          to: opts.to,
          subject: opts.subject,
          // Including the full body keeps the dev flow usable: the reset
          // link is right there in the log line. Operators piping logs to
          // a public sink should set SMTP_HOST instead of relying on this.
          text: opts.text,
        },
        'SMTP disabled — mail logged instead of sent',
      );
      return;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
      });
      this.log.debug(
        { event: 'mail.sent', to: opts.to, subject: opts.subject },
        'mail dispatched',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { event: 'mail.failed', to: opts.to, subject: opts.subject, err: message },
        'mail dispatch failed',
      );
    }
  }

  private defaultFrom(): string {
    try {
      const host = new URL(this.config.PUBLIC_BASE_URL).hostname || 'localhost';
      return `no-reply@${host}`;
    } catch {
      return 'no-reply@localhost';
    }
  }
}
