import { z } from "zod";
import { getPaymentHistory, getWalletAddress } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";

export const getHistorySchema = z.object({
  domain: z
    .string()
    .optional()
    .describe(
      "Filter payment history by domain (e.g. 'example.com'). Omit to return all payments across all domains.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe(
      "Maximum number of payment records to return (1-100, default 10). Use higher values to see full spending history.",
    ),
});

export type GetHistoryInput = z.infer<typeof getHistorySchema>;

export async function getHistory(
  input: GetHistoryInput,
  config: XenarchConfig,
) {
  const walletAddress = getWalletAddress(config);

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
