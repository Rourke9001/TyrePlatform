import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { ArrowRightIcon } from "../icons/ArrowRight";
import { CloseIcon } from "../icons/Close";
import { MenuIcon } from "../icons/Menu";
import { PlusIcon } from "../icons/Plus";
import { RefreshIcon } from "../icons/Refresh";
import { Routed } from "./actions.demo";
import type { GallerySection } from "./types";

export const section: GallerySection = {
  id: "actions",
  title: "Actions: buttons, links as buttons and icon buttons",
  render: () => (
    <div className="tr-stack">
      <div className="tr-cluster">
        <Button variant="primary">Start inspection</Button>
        <Button>Cancel</Button>
        <Button variant="ghost">Show all</Button>
        <Button variant="danger">Dispose</Button>
      </div>
      <div className="tr-cluster">
        <Button size="lg" icon={PlusIcon}>
          Add tyre
        </Button>
        <Button variant="primary" size="glove" iconEnd={ArrowRightIcon}>
          Next tyre
        </Button>
      </div>
      <div className="tr-cluster">
        <Button variant="primary" loading>
          Sending
        </Button>
        <Button disabled>Not yet</Button>
        <Routed>
          <Button to="/exceptions" variant="ghost" iconEnd={ArrowRightIcon}>
            See the list
          </Button>
        </Routed>
      </div>
      <Button variant="primary" size="glove" block>
        Send inspection
      </Button>
      <div className="tr-cluster">
        <IconButton label="Close" icon={CloseIcon} />
        <IconButton label="Refresh" icon={RefreshIcon} variant="secondary" />
        <IconButton label="Menu" icon={MenuIcon} size="glove" />
      </div>
    </div>
  ),
};
