export class ExchangeApprovedEvent {
  constructor(
    public readonly exchangeId: string,
    public readonly shopId: string,
    public readonly variantId: string,
    public readonly quantity: number = 1
  ) {}
}
