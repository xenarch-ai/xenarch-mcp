import { z } from "zod";
import { getPaymentHistory, createSigner } from "@xenarch/shared";
import type { XenarchConfig } from "@xenarch/shared";

export const getHistorySchema = z.object({
  domain: z
    .string()
    .optional()
    .describe("Filter history by domain. Returns all if omitted."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of results to return (1-100, default 10)."),
});

export type GetHistoryInput = z.infer<typeof getHistorySchema>;

export async function getHistory(
  input: GetHistoryInput,
  config: XenarchConfig,
) {
  const signer = createSigner(config);
  const walletAddress = await signer.getAddress();

  const history = await getPaymentHistory(config.apiBase, walletAddress, {
    domain: input.domain,
    limit: input.limit,
  });

  const totalSpent = history.reduce(
    (sum, item) => sum + parseFloat(item.amount_usd),
    0,
  );

  return {
    payments: history,
    total_spent_usd: totalSpent.toFixed(6),
    count: history.length,
    wallet: walletAddress,
  };
}
