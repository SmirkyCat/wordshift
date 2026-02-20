import { handleWordReview } from "../_lib/word-review.js";

export function onRequest(context) {
  return handleWordReview(context.request, context.env);
}
