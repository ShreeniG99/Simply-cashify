/** Raw Berka (PKDD'99) rows, field-for-field as documented. */

export type OrderRow = {
  orderId: string
  accountId: string
  bankTo: string
  accountTo: string
  /** Minor units (haléře). */
  amount: bigint
  kSymbol: string
}

export type TransRow = {
  transId: string
  accountId: string
  /** ISO 8601, converted from Berka's YYMMDD. */
  date: string
  type: 'PRIJEM' | 'VYDAJ' | 'VYBER'
  operation: string
  /** Minor units. */
  amount: bigint
  balance: bigint
  kSymbol: string
  bank: string
  account: string
}
