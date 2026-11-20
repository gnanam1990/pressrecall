export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (m: string) => new ApiError(400, "bad_request", m);
export const unauthorized = (m = "authentication required") =>
  new ApiError(401, "unauthorized", m);
export const forbidden = (m: string) => new ApiError(403, "forbidden", m);
export const notFound = (m: string) => new ApiError(404, "not_found", m);
export const conflict = (m: string) => new ApiError(409, "conflict", m);
export const policyDenied = (m: string) =>
  new ApiError(403, "policy_denied", m);
