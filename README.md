# CompactRank Aggregator

A single-file aggregator that puts every free model from the trial brief behind
one endpoint and always answers with the strongest one that can do the job.

Point an OpenAI or Anthropic client at it. It serves
`POST /v1/chat/completions`, `POST /v1/messages` (JSON or server-sent events)
and `GET /v1/models` in whichever shape the auth header asks for, and every
completion is a real call to a free OpenRouter model through the gateway —
never a locally invented answer.

## How it picks a model

- The catalog is parsed out of the brief at `$MAKEFUN_PROMPT_FILE`; nothing is
  hardcoded. `node main.ts --list` prints exactly the catalog document the
  server registers with the env.
- Requests naming `model: "auto"` are routed rating-greedy: free models are
  sorted by the brief's `rating_milli`, best first, and the first one whose
  capabilities cover the request wins. A request that declares tools needs a
  `tools: true` model, a JSON-mode `response_format` needs `json: true`, and
  image content needs `vision: true`. A request naming a concrete free model
  tries that model first.
- Anthropic requests are translated into a Chat Completions body before
  dialling (system prompt, images, tool definitions, tool use/results and tool
  choice included) and the answer is translated back, streaming included, with
  usage and stop reason carried across. Every response and every stream chunk
  reports the id that was actually dialled in its `model` field.

## Failover and cooldowns

A gateway refusal — HTTP 429, any 5xx, or a network error — is not an answer:
the request moves to the next ranked model that fits, and the refusals are
reported on the final response in the `x-makefun-upstream-failures` header.
Each model keeps a strike counter of consecutive failures. One strike already
costs it effective rank, so among near-equals a clean model is preferred;
two strikes in a row cool the model down, and the bench grows with the streak
(3, 6, 9, up to 12 requests) so a model that keeps refusing stops eating
prompts. If every model that fits is benched, the one whose bench ends
soonest is tried first. A single success wipes a model's slate clean.
Cooldowns are counted in requests, not seconds, and routing never reads the
clock, so a replayed trial makes the exact same choices.

## Running it

The trial harness starts it as `node main.ts` with `MAKEFUN_ENV_URL`,
`MAKEFUN_PROMPT_FILE`, `OPENAI_BASE_URL` and `OPENAI_API_KEY` set. It listens
on a free port (never 8080), registers its catalog, serves until
`GET $MAKEFUN_ENV_URL/work` reports `{"done": true}`, then exits 0.

## License

MIT — see `LICENSE`.
