import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Index } from "sequelize-typescript";

/**
 * Delivery record for every outbound email. Written by EmailDeliveryService on each
 * attempt's final outcome so admins can audit who received what, when, and whether it
 * succeeded (with the SMTP message id) or failed (with the error + attempt count).
 */
@Table({ tableName: "email_logs", timestamps: true })
export class EmailLog extends Model<EmailLog> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;

  @AllowNull(false) @Column(DataType.STRING(200)) declare recipient: string;
  @AllowNull(false) @Column(DataType.STRING(300)) declare subject: string;

  /** "sent" | "failed" | "stubbed" (no SMTP configured). */
  @AllowNull(false) @Index @Column(DataType.STRING(20)) declare status: string;

  @Column(DataType.STRING(200)) declare messageId: string | null;
  @Column(DataType.TEXT) declare error: string | null;

  /** How many send attempts were made before this outcome. */
  @Default(1) @Column(DataType.INTEGER) declare attempts: number;

  /** Free-form origin tag, e.g. "scheduled_report:<uuid>". Indexed for history lookups. */
  @Index @Column(DataType.STRING(120)) declare context: string | null;

  /** Attachment filenames included (for the history view), e.g. ["report.pdf"]. */
  @Column(DataType.JSONB) declare attachments: unknown;
}
