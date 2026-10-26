import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PhotoCapture, type Photo } from "./PhotoCapture";

const photos: Photo[] = [
  { id: "p1", src: "data:image/png;base64,AA==", state: "saved" },
  { id: "p2", src: "data:image/png;base64,AA==", state: "waiting" },
  { id: "p3", src: "data:image/png;base64,AA==", state: "sending" },
  { id: "p4", src: "data:image/png;base64,AA==", state: "sent" },
  { id: "p5", src: "data:image/png;base64,AA==", state: "failed" },
];

const file = (name: string) => new File(["x"], name, { type: "image/jpeg" });

const picker = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
};

describe("PhotoCapture", () => {
  // FR-INS-039: the tenant requires a photo, so the ask comes first.
  it("asks for a photo when one is required and none is taken", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PhotoCapture
        photos={[]}
        onAdd={vi.fn()}
        required
        reason="Show the cut on the sidewall."
        subject="LINK-A position 3"
      />,
    );
    expect(screen.getByText("Photo needed")).toBeInTheDocument();
    expect(screen.getByText("Show the cut on the sidewall.")).toBeInTheDocument();
    const input = picker(container);
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("capture", "environment");
    const click = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Take photo" }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("hands the camera's files to onAdd, no more than max allows", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn<(files: File[]) => void>();
    const { container } = render(
      <PhotoCapture
        photos={photos.slice(0, 2)}
        onAdd={onAdd}
        subject="LINK-A position 3"
        max={3}
      />,
    );
    await user.upload(picker(container), [file("a.jpg"), file("b.jpg")]);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd.mock.calls[0][0].map((f) => f.name)).toEqual(["a.jpg"]);
  });

  // NFR-USE-009 and FR-OFF-018: each photo's place in the queue, in words.
  it("shows each photo's queue state in words and names it for its subject", () => {
    render(<PhotoCapture photos={photos} onAdd={vi.fn()} subject="LINK-A position 3" />);
    for (const word of ["On phone", "Needs Wi-Fi", "Sending", "Sent", "Not sent yet"]) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
    expect(screen.getByRole("img", { name: "Photo 1 of LINK-A position 3" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Photo 5 of LINK-A position 3" })).toBeInTheDocument();
  });

  it("removes a photo by its own button", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn<(id: string) => void>();
    render(
      <PhotoCapture
        photos={photos.slice(0, 2)}
        onAdd={vi.fn()}
        onRemove={onRemove}
        subject="LINK-A position 3"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove photo 2" }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("p2");
  });

  // Rule 5: a cap on photos is the caller's, so without max the add tile stays.
  it("offers another photo until the caller's max is reached", () => {
    const { rerender } = render(
      <PhotoCapture photos={photos} onAdd={vi.fn()} subject="LINK-A position 3" />,
    );
    expect(screen.getByRole("button", { name: "Another" })).toBeInTheDocument();

    rerender(<PhotoCapture photos={[]} onAdd={vi.fn()} subject="LINK-A position 3" />);
    expect(screen.getByRole("button", { name: "Add photo" })).toBeInTheDocument();

    rerender(<PhotoCapture photos={photos} onAdd={vi.fn()} subject="LINK-A position 3" max={5} />);
    expect(screen.queryByRole("button", { name: "Another" })).toBeNull();
  });

  // FR-OFF-008: short of space, capture defers instead of blocking.
  it("defers the photo when the phone is short of space", () => {
    const { container } = render(
      <PhotoCapture photos={[]} onAdd={vi.fn()} required subject="LINK-A position 3" storageLow />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Not enough space for photos");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("passes unknown props to its root", () => {
    const { container } = render(
      <PhotoCapture photos={[]} onAdd={vi.fn()} subject="LINK-A position 3" data-testid="photos" />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-testid", "photos");
  });
});
