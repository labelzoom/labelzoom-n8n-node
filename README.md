# n8n-nodes-labelzoom

An [n8n](https://n8n.io) community node for [LabelZoom](https://www.labelzoom.com) — convert
barcode labels between ZPL, EPL, TSPL, DPL, PDF, images and XML/JSON, and print them to
cloud-connected thermal printers.

The labels in a business rarely arrive in the format the printer wants. A WMS emits ZPL, a
carrier hands you a PDF, an old Eltron on the packing bench speaks EPL. This node turns that
into two steps in a workflow.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) ·
[Examples](#examples) · [Development](#development)

## Installation

In n8n, go to **Settings → Community nodes → Install** and enter:

```
n8n-nodes-labelzoom
```

Self-hosted installs can also use npm directly:

```sh
npm install n8n-nodes-labelzoom
```

## Credentials

Create a **LabelZoom API** credential with the API key from the **API Access** section of your
[dashboard](https://www.labelzoom.com/dashboard).

**Converting works without a credential.** Leave it unset and the node runs on the free tier —
unlimited conversions, watermarked output, first label only, 1 MB request cap. Add a key when
you're ready to ship.

**Printing requires a key with the `print` scope**, because a print job goes to *your* printer.
`print` implies `convert`, so one key covers both.

| Field | Notes |
| --- | --- |
| API Key | Optional for Label operations, required for Printer operations |
| Max Retries | 429s and 5xx are retried with exponential backoff. `0` fails fast. Client errors are never retried. |
| Base URL | Only change this if you were given a dedicated endpoint |

## Operations

### Label

| Operation | What it does |
| --- | --- |
| **Convert** | Convert a document between any supported source and target format |
| **Convert Template** | Fill a Print Template with data and render it, without printing |

Sources: `zpl` `epl` `tspl` `dpl` `xml` `json` `pdf` `png` `bmp` `gif` `jpeg` `jpg` `url`
Targets: `zpl` `epl` `tspl` `dpl` `xml` `json` `pdf` `png` `bmp` `gif` `jpeg`

`url` is a source only — post a link and LabelZoom fetches the document itself. `jpg` is an
input spelling that normalizes to `jpeg`.

The output is always a **binary field**, because five of the eleven targets are binary. A
decoded `text` field is added for `zpl`, `xml` and `json` as a convenience. It is deliberately
*not* added for `epl`, `tspl` or `dpl`: those come back as `text/plain` but can inline raw
bytes (EPL's `GW`, TSPL's `BITMAP`, DPL's leading `STX`), and decoding them to a string would
corrupt any label carrying graphics.

Options cover the full parameter set — DPI, rotation, scaling, colour mode, darkness, label
size in inches, position, PDF conversion mode and page number, ZPL image compression and
commands to ignore, and a **Variable Data** field that fills placeholders on the label (one
output label per array entry). Anything not yet surfaced in the UI can go through **Custom
Parameters (JSON)**.

### Printer

> **Cloud Print is in private beta.** Endpoints and payloads may change.
> [Apply for access](https://www.labelzoom.com/beta).

| Operation | What it does |
| --- | --- |
| **Print** | Send a document to a printer, converting it in transit |
| **Print Template** | Fill a Print Template with data and print it |
| **Get Job** | Look up a print job to see whether it actually printed |
| **Get Many** | List the printers on your account |
| **Get Status** | One printer's live status and its bound agents |

Printing sends the document as-is; if it doesn't match the printer's native format, LabelZoom
converts it on the way — a carrier PDF sent to a Zebra becomes ZPL automatically. Every
transform option from Convert works here too, even when no format change is needed.

**`dispatched` and `queued` mean *accepted*, not *printed*.** A job only reaches `completed`
once the print agent reports back. Turn on **Wait for Completion** when the workflow needs to
know the label came out of the printer.

**Idempotency.** Print carries an `Idempotency-Key`; repeating a key returns the original job
instead of printing again. It defaults to `{{ $execution.id }}-{{ $itemIndex }}`, which makes a
retried *step* safe. Set it from an order number to make a whole workflow re-run safe too — a
duplicate shipping label is a real cost.

## Examples

**Carrier PDF → Zebra.** HTTP Request (download the label PDF) → LabelZoom (Printer → Print,
source format `pdf`, pick your ZPL printer). One step; the conversion is implicit.

**Preview a ZPL label.** LabelZoom (Label → Convert, `zpl` → `png`) → Send Email. Useful for a
"does this template look right" approval step before a production run.

**Batch from a spreadsheet.** Google Sheets → LabelZoom (Label → Convert, `zpl` → `pdf`, with
Variable Data mapped from the rows) → Google Drive. Each row becomes one page.

**Fill a designed template.** Design in LabelZoom Studio, publish it to Print Templates, then
Printer → Print Template with the merge fields mapped from the incoming item. The template
picker shows each template's merge fields, so you can see what data it wants.

## Development

```sh
npm install
npm run dev          # a local n8n with this node linked
npm run build
npm run lint         # the n8n community-node linter (the verification gate)
npm run typecheck
npm test
```

### The conformance suite

n8n verification forbids runtime dependencies, so this node cannot call
[`@labelzoom/sdk`](https://www.npmjs.com/package/@labelzoom/sdk) — it re-implements the
LabelZoom wire contract by hand. To stop the two drifting apart, it runs the **same
language-neutral conformance fixtures** the eight official SDKs run: 83 cases pinned from
`labelzoom-sdk` covering request shape, error mapping, retry policy and local validation.

```sh
npm run sync-conformance             # refresh test/conformance/ from the pinned SDK tag
node scripts/sync-conformance.mjs --check   # verify it hasn't drifted (CI)
```

The suite asserts its own coverage — `executed == spec.cases - declared skips` — so a
partially-implemented runner can't quietly report green. Each skip carries a written reason in
[`test/conformance-skips.json`](test/conformance-skips.json).

There is one deliberate deviation, documented in the runner: the fixtures pin a `User-Agent`
matching `^labelzoom-[a-z0-9]+-sdk/`, the SDK family's naming. This is an n8n node, not an SDK,
and calling itself one on the wire would misreport what's talking to the API. It sends
`labelzoom-n8n-node` instead, and the substance of that rule — identify yourself, and never
claim to be LabelZoom Studio, whose prefix the server special-cases — is asserted directly in
`test/node.test.ts`.

## Resources

- [LabelZoom API docs](https://docs.labelzoom.com)
- [Conversion parameters](https://docs.labelzoom.com/reference/conversion-parameters/)
- [Cloud Print API](https://docs.labelzoom.com/reference/cloud-print-api/)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
