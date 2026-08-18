export type BrokerRequest = {
  method?: string;
  body?: Record<string, unknown>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
};

export type BrokerResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): BrokerResponse;
  json(value: unknown): void;
  send(value: unknown): void;
  redirect(code: number, location: string): void;
};
