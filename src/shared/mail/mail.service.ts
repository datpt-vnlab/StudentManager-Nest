import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import nodemailer, { Transporter } from "nodemailer";

type SendMailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor() {
    const host = process.env.MAIL_HOST;
    const port = Number(process.env.MAIL_PORT ?? 587);
    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;
    const secure = process.env.MAIL_SECURE === "true" || port === 465;

    if (!host || !user || !pass) {
      throw new InternalServerErrorException(
        "Mail configuration is missing. Please set MAIL_HOST, MAIL_PORT, MAIL_USER, and MAIL_PASS.",
      );
    }

    this.from = process.env.MAIL_FROM ?? user;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
  }

  async verifyConnection(): Promise<void> {
    try {
      await this.transporter.verify();
      this.logger.log("Mail connection verified successfully.");
    } catch (error) {
      this.logger.error("Failed to verify mail connection.", error);
      throw new InternalServerErrorException(
        "Mail connection failed. Please check mail settings.",
      );
    }
  }

  async sendMail(payload: SendMailInput): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });

      this.logger.log(`Email sent to ${payload.to}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${payload.to}`, error);
      throw new InternalServerErrorException(
        "Failed to send email. Please try again.",
      );
    }
  }

  async sendOtpEmail(to: string, otpCode: string, ttlMinutes: number): Promise<void> {
    const subject = "Your Admin Login OTP";
    const text = `Your OTP code is ${otpCode}. It will expire in ${ttlMinutes} minute(s).`;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.5;">
        <h2>Admin Login OTP</h2>
        <p>Your one-time password is:</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${otpCode}</p>
        <p>This OTP expires in <strong>${ttlMinutes} minute(s)</strong>.</p>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    `;

    await this.sendMail({ to, subject, html, text });
  }
}
