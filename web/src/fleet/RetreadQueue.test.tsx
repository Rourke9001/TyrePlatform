import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RetreadQueue } from "./RetreadQueue";
import type { TyreCatalogue } from "../api/catalogue";
import type { RetreadJob } from "../api/retreads";
import { renderWithActor, requestedUrl, respond } from "../test/fixtures";

function job(overrides: Partial<RetreadJob> & { id: string }): RetreadJob {
  return {
    tyreId: "t1",
    displayCode: "POS1",
    depotName: "Retread Co",
    sentAt: "2026-08-01",
    daysOut: 5,
    patternId: "rp1",
    patternName: "Recap",
    ...overrides,
  };
}

// A retread pattern, a BOTH pattern and a new-tyre one the picker must not
// offer (FR-CFG-004).
const CATALOGUE: TyreCatalogue = {
  sizes: [],
  brands: [],
  patterns: [
    { id: "rp1", name: "Recap", brandId: null, appliesTo: "RETREAD", platformCatalogueId: null },
    {
      id: "bp1",
      name: "All Position",
      brandId: null,
      appliesTo: "BOTH",
      platformCatalogueId: null,
    },
    { id: "np1", name: "SP431", brandId: null, appliesTo: "NEW", platformCatalogueId: null },
  ],
};

type Reply = () => Response | Promise<Response>;

// GET /api/retread-jobs?open=true takes the next of `jobs`, the last one
// repeating; GET /api/tyre-catalogue answers `catalogue` (null: it never
// answers); each POST to a job's return takes the next of `returns`.
// Anything else is a request this screen should not make.
function mockApi({
  jobs,
  catalogue = () => respond(200, CATALOGUE),
  returns = [],
}: {
  jobs: RetreadJob[][];
  catalogue?: Reply | null;
  returns?: Reply[];
}) {
  const jobQueue = [...jobs];
  const returnQueue = [...returns];
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    if (init?.method !== "POST" && url === "/api/retread-jobs?open=true") {
      const next = jobQueue.length > 1 ? jobQueue.shift() : jobQueue[0];
      return Promise.resolve(respond(200, next ?? []));
    }
    if (url === "/api/tyre-catalogue") {
      return catalogue === null
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(catalogue());
    }
    const reply = returnQueue.shift();
    if (init?.method === "POST" && /^\/api\/retread-jobs\/[^/]+\/return$/.test(url) && reply) {
      return Promise.resolve(reply());
    }
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
}

// Every POST in order, with its body.
function posts(): { url: string; body: unknown }[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "POST")
    .map(([input, init]) => ({
      url: requestedUrl(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    }));
}

const noContent: Reply = () => new Response(null, { status: 204 });

function renderScreen() {
  return renderWithActor(<RetreadQueue />, { capabilities: ["LogRetread"], withRouter: true });
}

describe("the retread queue", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // sentAt is genuinely date-only on the wire (retreads.go's own
  // `sent_at::text` select, a date column) and renders in UTC unshifted;
  // daysOut is the server's own arithmetic, rendered as given.
  it("renders sent on through useTenantDate and days out from the server", async () => {
    mockApi({ jobs: [[job({ id: "j1", sentAt: "2026-08-01", daysOut: 12 })]] });
    renderScreen();

    const row = (await screen.findByRole("rowheader", { name: "POS1" })).closest("tr");
    if (!row) throw new Error("row for POS1 not found");
    expect(within(row).getByText("01 Aug 2026")).toBeInTheDocument();
    expect(within(row).getByText("12")).toBeInTheDocument();
  });

  it("hides the money inputs when Rejected is chosen", async () => {
    mockApi({ jobs: [[job({ id: "j1" })]] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));

    expect(screen.queryByLabelText(/retread cost for pos1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/post-tread for pos1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/casing value for pos1/i)).not.toBeInTheDocument();
  });

  // jsdom/fireEvent.submit test technique: see the fireEvent.submit comment in ReceiveTyre.test.tsx.
  it("shows a local refusal, not a silent no-op, when required fields are missing", async () => {
    mockApi({ jobs: [[job({ id: "j1" })]] });
    const user = userEvent.setup();
    const { container } = renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    const form = container.querySelector("form");
    if (form === null) throw new Error("expected a form element");
    fireEvent.submit(form);

    expect(await screen.findByRole("alert")).toHaveTextContent(/before a return can be logged/i);
    expect(posts()).toHaveLength(0);
  });

  // 2026-08-26 lesson: literal inputs, unrounded, exactly as typed; the
  // database rounds. open=true excludes a closed job, so every post-write
  // refetch reads the empty list.
  it("posts the accepted body with money as strings", async () => {
    mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-1");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.type(screen.getByLabelText(/retread cost for pos1/i), "2500.005");
    await user.type(screen.getByLabelText(/post-tread for pos1/i), "16");
    await user.type(screen.getByLabelText(/casing value for pos1/i), "800");
    await user.click(screen.getByRole("button", { name: /log return/i }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toStrictEqual({
      url: "/api/retread-jobs/j1/return",
      body: {
        returnedOn: "2026-08-20",
        casingAccepted: true,
        reportReference: "RPT-1",
        retreadCost: "2500.005",
        postTreadMm: "16",
        casingValue: "800",
      },
    });
  });

  // Omitted-optional-field pattern: see omitIfBlank in RetreadQueue.tsx.
  it("omits a money field typed as whitespace rather than sending an empty string", async () => {
    mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-3");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.type(screen.getByLabelText(/retread cost for pos1/i), "   ");
    await user.type(screen.getByLabelText(/post-tread for pos1/i), "16");
    await user.type(screen.getByLabelText(/casing value for pos1/i), "800");
    // A real click, not fireEvent.submit: the point is that the browser's own
    // required check passes on whitespace, so the write is reached.
    await user.click(screen.getByRole("button", { name: /log return/i }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url).toBe("/api/retread-jobs/j1/return");
    expect(posts()[0]?.body).not.toHaveProperty("retreadCost");
    expect(posts()[0]?.body).toStrictEqual({
      returnedOn: "2026-08-20",
      casingAccepted: true,
      reportReference: "RPT-3",
      postTreadMm: "16",
      casingValue: "800",
    });
  });

  it("posts the rejected body without a cost or a casing value", async () => {
    mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-2");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toStrictEqual({
      url: "/api/retread-jobs/j1/return",
      body: { returnedOn: "2026-08-20", casingAccepted: false, reportReference: "RPT-2" },
    });
  });

  // The confirmation lives at RetreadQueue, not inside the row. The same
  // refetch that surfaces it also removes the closed job's row, proving the
  // message did not come from a row still on screen.
  it("shows the confirmation once the job's own row has left the list on the refetch", async () => {
    mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-3");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/the return for pos1 was logged/i);
    expect(screen.queryByRole("rowheader", { name: "POS1" })).not.toBeInTheDocument();
  });

  // TY015's own sentence is the whole content of the refusal (NFR-USE-005),
  // rendered verbatim, not replaced by a general one, mirroring
  // DispatchForm.test.tsx's own TY015 case.
  it("renders TY015's message verbatim when the casing is at its retread cap", async () => {
    mockApi({
      jobs: [[job({ id: "j1" })]],
      returns: [
        () =>
          respond(422, {
            code: "TY015",
            message:
              "this casing has been retreaded 4 time(s), at a cap of 4; at its cap it is a purchase, not a retread candidate",
          }),
      ],
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-4");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.type(screen.getByLabelText(/retread cost for pos1/i), "2500");
    await user.type(screen.getByLabelText(/post-tread for pos1/i), "16");
    await user.type(screen.getByLabelText(/casing value for pos1/i), "800");
    await user.click(screen.getByRole("button", { name: /log return/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /a purchase, not a retread candidate/i,
    );
  });

  // The confirmation names one closed job; it must not still be standing
  // once an operator's attention has visibly moved to another job's return
  // (NFR-USE-010).
  it("clears the confirmation once a return is started on a different job", async () => {
    mockApi({
      jobs: [
        [job({ id: "j1" }), job({ id: "j2", displayCode: "POS2" })],
        [job({ id: "j2", displayCode: "POS2" })],
      ],
      returns: [noContent],
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    const row1 = within(screen.getByRole("rowheader", { name: "POS1" }).closest("tr")!);
    await user.click(row1.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-1");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(row1.getByRole("button", { name: /log return/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/the return for pos1 was logged/i);

    await user.click(screen.getByRole("radio", { name: "Rejected" }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // B23, U225 (TYRE-102): an accepted casing comes back on an active retread
  // pattern, pre-selected when it went out on one, and the form sends it
  // only when it changed.
  describe("the pattern it came back on", () => {
    async function acceptWithFigures(user: ReturnType<typeof userEvent.setup>, code = "pos1") {
      await user.click(screen.getByRole("radio", { name: "Accepted" }));
      await user.type(
        screen.getByLabelText(new RegExp(`report reference for ${code}`, "i")),
        "RPT-9",
      );
      fireEvent.change(screen.getByLabelText(new RegExp(`returned on for ${code}`, "i")), {
        target: { value: "2026-08-20" },
      });
      await user.type(screen.getByLabelText(new RegExp(`retread cost for ${code}`, "i")), "2500");
      await user.type(screen.getByLabelText(new RegExp(`post-tread for ${code}`, "i")), "16");
      await user.type(screen.getByLabelText(new RegExp(`casing value for ${code}`, "i")), "800");
    }

    function optionNames(select: HTMLElement): (string | null)[] {
      return within(select)
        .getAllByRole("option")
        .map((o) => o.textContent);
    }

    it("offers the active retread patterns, never a new-tyre one, with the casing's own pre-selected and unsent", async () => {
      mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
      const user = userEvent.setup();
      renderScreen();
      await screen.findByRole("rowheader", { name: "POS1" });

      await acceptWithFigures(user);
      const picker = await screen.findByRole("combobox", { name: "Pattern for POS1" });
      expect(optionNames(picker)).toEqual(["Choose the retread pattern", "All Position", "Recap"]);
      await waitFor(() => expect(picker).toHaveValue("rp1"));
      expect(picker).toBeRequired();
      await user.click(screen.getByRole("button", { name: /log return/i }));

      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).not.toHaveProperty("newPatternId");
    });

    it("starts a casing that went out on a new-tyre pattern on the placeholder and refuses until one is chosen", async () => {
      mockApi({
        jobs: [[job({ id: "j1", patternId: "np1", patternName: "SP431" })], []],
        returns: [noContent],
      });
      const user = userEvent.setup();
      const { container } = renderScreen();
      await screen.findByRole("rowheader", { name: "POS1" });

      await acceptWithFigures(user);
      const picker = await screen.findByRole("combobox", { name: "Pattern for POS1" });
      expect(picker).toHaveValue("");
      expect(
        screen.getByText("Went out on SP431. Choose the pattern it came back on."),
      ).toBeInTheDocument();
      const form = container.querySelector("form");
      if (form === null) throw new Error("expected a form element");
      fireEvent.submit(form);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Choose the retread pattern the casing came back on.",
      );
      expect(posts()).toHaveLength(0);

      await user.selectOptions(picker, "bp1");
      await user.click(screen.getByRole("button", { name: /log return/i }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toMatchObject({ newPatternId: "bp1" });
    });

    it("sends a pattern chosen in place of the casing's own", async () => {
      mockApi({ jobs: [[job({ id: "j1" })], []], returns: [noContent] });
      const user = userEvent.setup();
      renderScreen();
      await screen.findByRole("rowheader", { name: "POS1" });

      await acceptWithFigures(user);
      const picker = await screen.findByRole("combobox", { name: "Pattern for POS1" });
      await waitFor(() => expect(picker).toHaveValue("rp1"));
      await user.selectOptions(picker, "bp1");
      await user.click(screen.getByRole("button", { name: /log return/i }));

      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toMatchObject({ newPatternId: "bp1" });
    });

    it("says the fleet has no retread pattern and sends nothing for an accepted casing, while a rejection still sends", async () => {
      mockApi({
        jobs: [[job({ id: "j1", patternId: "np1", patternName: "SP431" })], []],
        catalogue: () =>
          respond(200, {
            ...CATALOGUE,
            patterns: CATALOGUE.patterns.filter((p) => p.appliesTo === "NEW"),
          }),
        returns: [noContent],
      });
      const user = userEvent.setup();
      const { container } = renderScreen();
      await screen.findByRole("rowheader", { name: "POS1" });

      await acceptWithFigures(user);
      expect(
        await screen.findByText(
          "This fleet has no retread pattern yet. Ask an administrator to add the retreader's patterns, then log the return.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /log return/i })).toBeDisabled();
      const form = container.querySelector("form");
      if (form === null) throw new Error("expected a form element");
      fireEvent.submit(form);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posts()).toHaveLength(0);

      await user.click(screen.getByRole("radio", { name: "Rejected" }));
      await user.click(screen.getByRole("button", { name: /log return/i }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toMatchObject({ casingAccepted: false });
    });

    it("pre-selects the casing's own pattern when the catalogue answers after the jobs", async () => {
      let answer: (r: Response) => void = () => undefined;
      const late = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      mockApi({ jobs: [[job({ id: "j1" })]], catalogue: () => late });
      const user = userEvent.setup();
      renderScreen();
      await screen.findByRole("rowheader", { name: "POS1" });
      await user.click(screen.getByRole("radio", { name: "Accepted" }));

      answer(respond(200, CATALOGUE));
      const picker = await screen.findByRole("combobox", { name: "Pattern for POS1" });
      await waitFor(() => expect(picker).toHaveValue("rp1"));
    });

    it("says the catalogue could not be loaded and offers a retry", async () => {
      mockApi({
        jobs: [[job({ id: "j1" })]],
        catalogue: () => respond(500, { code: "internal", message: "internal error" }),
      });
      renderScreen();

      expect(
        await screen.findByText(
          "The tyre catalogue could not be loaded. Check your connection, then retry.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
  });

  it("links back to the register", async () => {
    mockApi({ jobs: [[]] });
    renderScreen();

    expect(await screen.findByRole("link", { name: /back to register/i })).toHaveAttribute(
      "href",
      "/fleet/tyres",
    );
  });

  it("shows a note card when no casings are out for retread", async () => {
    mockApi({ jobs: [[]] });
    renderScreen();

    expect(await screen.findByText(/no casings are out for retread/i)).toBeInTheDocument();
  });
});
