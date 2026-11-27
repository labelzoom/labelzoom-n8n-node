# n8n-nodes-labelzoom

An [n8n](https://n8n.io) community node for [LabelZoom](https://www.labelzoom.com) — convert
barcode labels between printer languages, label design files, PDF, images and XML/JSON, and print
them to cloud-connected thermal printers.

The labels in a business rarely arrive in the format the printer wants. A WMS emits ZPL, a
carrier hands you a PDF, an old Eltron on the packing bench speaks EPL. This node turns that
into two steps in a workflow.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) ·
[Examples](#examples) · [Development](#development)

## Installation

The node is [verified by n8n](https://n8n.io/integrations/labelzoom/), so it installs straight
from the canvas: open the nodes panel, search for **LabelZoom**, and pick it from **More from the
community**.

To install it by package name instead, go to **Settings → Community nodes → Install** and enter:

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

**Converting works without a credential.** Leave it unset and the node runs on the free tier:
unlimited conversions with watermarked output, and the first label of each request (set
**Label Index** to convert any other one). Add a key when you're ready to ship.

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

| Kind | Sources | Targets |
| --- | --- | --- |
| Printer languages | `zpl` `epl` `ipl` `tspl` `dpl` `sbpl` `cpcl` `esclabel` `fingerprint` `ezpl` `tpcl` | `zpl` `epl` `ipl` `tspl` `dpl` `sbpl` `cpcl` |
| Label design files | `nlbl` `lbl` (NiceLabel), `btw` (BarTender), `dymo` (DYMO) | — |
| Documents and images | `pdf` `png` `bmp` `gif` `jpeg` `jpg` | `pdf` `png` `bmp` `gif` `jpeg` |
| LabelZoom | `xml` `json` | `xml` `json` |
| Other | `url` | — |

`url` is a source only — post a link and LabelZoom fetches the document itself. `jpg` is an
input spelling that normalizes to `jpeg`. NiceLabel and BarTender files are binary: attach them as
a binary file.

The output is always a **binary field**, because five of the fourteen targets are binary. A
decoded `text` field is added for `zpl`, `cpcl`, `xml` and `json` as a convenience. It is deliberately
*not* added for `epl`, `ipl`, `tspl`, `dpl` or `sbpl`: those come back as `text/plain` but can
inline raw bytes (EPL's `GW`, IPL's `STX`/`ETX` framing, TSPL's `BITMAP`, DPL's leading `STX`,
SBPL's `ESC`-prefixed commands), and decoding them to a string would corrupt any label carrying
graphics.

Options cover the full parameter set — Source DPI and Target DPI, rotation, scaling, color mode,
darkness, label size in inches, position, PDF conversion mode and page number, label index, ZPL
image compression, commands to ignore and collapsing identical labels, and a **Variable Data**
field that fills placeholders on the label (one output label per array entry). Anything not yet
surfaced in the UI can go through **Custom Parameters (JSON)**.

| Option | What it does |
| --- | --- |
| **Source DPI** | The resolution the label code or image was made for. Printer-language and image sources only; when **Target DPI** is unset, the output follows it |
| **Target DPI** | The resolution of the output. Every target except PDF |
| **Label Index** | Convert one label of a multi-label document, counting from 0 |
| **Split Page Into Labels** | Cut each page of a PDF or image into a grid of labels, such as a sheet of address labels. Lengths are in inches |
| **Layout** | Put several labels side by side on a multi-across roll (printer-language output from a PDF or image) |
| **Collapse Identical Labels** | Write each run of identical labels as one ZPL label with a `^PQ` count |

Split, layout and collapsing need **PDF Conversion Mode** set to **Image**, the default.

Workflows saved with an earlier version of the node keep their single **DPI** option and send
the request they always sent. A LabelZoom node added to a workflow now offers **Source DPI** and
**Target DPI** in its place.

### Printer

> **Cloud Print is in public beta.** Endpoints and payloads may change.
> [Set up a printer](https://www.labelzoom.com/cloud-print).

| Operation | What it does |
| --- | --- |
| **Print** | Send a document to a printer, converting it in transit |
| **Print Template** | Fill a Print Template with data and print it |
| **Get Job** | Look up a print job to see whether it actually printed |
| **Get Many** | List the printers on your account |
| **Get Status** | One printer's live status and its bound agents |
| **Get Print Quota** | Your plan's agent, printer and daily job limits, what's used, and when the daily count resets |

Printing sends the document as-is; if it doesn't match the printer's native format, LabelZoom
converts it on the way — a carrier PDF sent to a Zebra becomes ZPL automatically. Every
transform option from Convert works here too, even when no format change is needed.

Every source format prints except `url`. Print takes the document as a binary file or as text,
not as base64 text: turn base64 into a file with n8n's **Convert to File** node first.
**Auto-Detect** recognizes PDFs and images only, so choose the source format for anything else.

**Print Template** takes one record as a JSON object. An array of objects prints one label per
entry as a single batch, and the output then lists the `jobs`, with `remaining` counting any
entries at the end that weren't submitted. Run the step again with the same idempotency key to
submit them.

When the daily print job limit is reached, the node fails the item without retrying: the limit
resets at midnight UTC, so a retry can only fail again.

**`dispatched` and `queued` mean *accepted*, not *printed*.** A job only reaches `completed`
once the print agent reports back. Turn on **Wait for Completion** when the workflow needs to
know the label came out of the printer.

**Copies.** Print and Print Template both take **Copies**: how many times the job is sent to the
printer, from 1 to 9999, for any document in any printer language. **A print quantity already in
the label or template multiplies** — a label carrying `^PQ3` sent with Copies set to 5 prints 15.
A document holding several labels prints collated (A, B, A, B), all as a single job, and the job in
the output reports the `copies` it was accepted with (`null` when Copies was left at 1). Leave
Copies at the default of 1 and nothing is sent: the document prints once, as sent, exactly as
before. Map it from the incoming item to print a per-order quantity:

```
{{ $json.quantity }}
```

A number that arrives as text, such as `"25"` from a CSV or spreadsheet, is accepted. Anything
that isn't a whole number from 1 to 9999 fails the item before a request is made. Copies above 1
needs an up-to-date LabelZoom Print Agent: if the agent serving the printer is out of date, the
job is rejected with a 422 asking you to update it, rather than printed a different number of
times. For a large run of a complex label, the printer language's own quantity command inside the
label (`^PQ` in ZPL, for example) prints faster than sending the whole job again and again.

**Idempotency.** Print carries an `Idempotency-Key`; repeating a key returns the original job
instead of printing again. It defaults to `{{ $execution.id }}-{{ $itemIndex }}`, which makes a
retried *step* safe. Clear the field and the node generates a random key for each print, used for
that print's retries. Set it from an order number to make a whole workflow re-run safe too — a
duplicate shipping label is a real cost. A key identifies the whole request, Copies included:
repeating it with a different document, merge data or Copies is rejected with a 422 instead of
replaying the original job, so give a deliberate reprint a key of its own.

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

**One label per unit.** An order-line trigger (or a spreadsheet of SKUs) → LabelZoom (Printer →
Print Template, merge fields mapped from the line, **Copies** set to `{{ $json.quantity }}`). A
line for 12 units sends its label to the printer 12 times as one job. Design the template to
print a single label: a quantity built into the template multiplies with Copies.

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
language-neutral conformance fixtures** the eight official SDKs run, pinned to an SDK release
tag in `labelzoom-sdk` and covering request shape, error mapping, retry policy, printing and
local validation.

```sh
npm run sync-conformance             # refresh test/conformance/ from the pinned SDK ref
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

- [LabelZoom on n8n.io](https://n8n.io/integrations/labelzoom/) — the verified integration listing
- [n8n integration guide](https://docs.labelzoom.com/integrations/n8n/) — this node, end to end
- [LabelZoom API docs](https://docs.labelzoom.com)
- [Conversion parameters](https://docs.labelzoom.com/reference/conversion-parameters/)
- [Cloud Print API](https://docs.labelzoom.com/reference/cloud-print-api/)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
