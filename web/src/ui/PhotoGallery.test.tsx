import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PhotoGallery, type GalleryPhoto } from "./PhotoGallery";

const photos: GalleryPhoto[] = [
  { id: "a", src: "data:image/png;base64,AA==", caption: "LINK-A position 3", meta: "today 07:42" },
  { id: "b", src: "data:image/png;base64,AA==", caption: "LINK-A position 4" },
  { id: "c", src: "data:image/png;base64,AA==", caption: "LINK-B spare" },
];

describe("PhotoGallery", () => {
  it("says so when there are no photos", () => {
    const { rerender } = render(<PhotoGallery photos={[]} />);
    expect(screen.getByText("No photos.")).toBeInTheDocument();
    rerender(<PhotoGallery photos={[]} empty="No photo was required." />);
    expect(screen.getByText("No photo was required.")).toBeInTheDocument();
  });

  it("opens a photo in a viewer named by its caption, with Close focused", async () => {
    const user = userEvent.setup();
    render(<PhotoGallery photos={photos} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open photo: LINK-A position 4" }));
    const viewer = screen.getByRole("dialog", { name: "LINK-A position 4" });
    expect(viewer).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("img", { name: "LINK-A position 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("moves between photos with the arrow keys and the buttons, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<PhotoGallery photos={photos} />);
    await user.click(screen.getByRole("button", { name: "Open photo: LINK-B spare" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "LINK-A position 3" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "LINK-B spare" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(screen.getByRole("dialog", { name: "LINK-A position 4" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "LINK-B spare" })).toBeInTheDocument();
  });

  it("closes on Escape and on Close, returning focus to the photo that opened it", async () => {
    const user = userEvent.setup();
    render(<PhotoGallery photos={photos} />);
    const opener = screen.getByRole("button", { name: "Open photo: LINK-A position 3" });
    await user.click(opener);
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside the open viewer, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind the viewer</button>
        <PhotoGallery photos={photos} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open photo: LINK-A position 3" }));
    const previous = screen.getByRole("button", { name: "Previous photo" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();

    await user.tab();
    expect(previous).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Next photo" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(previous).toHaveFocus();
  });

  it("offers no previous or next for a single photo", async () => {
    const user = userEvent.setup();
    render(<PhotoGallery photos={photos.slice(0, 1)} />);
    await user.click(screen.getByRole("button", { name: "Open photo: LINK-A position 3" }));
    expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });

  it("passes unknown props to its list", () => {
    render(<PhotoGallery photos={photos} data-testid="gallery" />);
    expect(screen.getByRole("list")).toHaveAttribute("data-testid", "gallery");
  });
});
