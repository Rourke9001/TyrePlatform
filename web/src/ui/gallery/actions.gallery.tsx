import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { ArrowRight } from "../icons/ArrowRight";
import { Close } from "../icons/Close";
import { Menu } from "../icons/Menu";
import { Plus } from "../icons/Plus";
import { Refresh } from "../icons/Refresh";
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
        <Button size="lg" icon={Plus}>
          Add tyre
        </Button>
        <Button variant="primary" size="glove" iconEnd={ArrowRight}>
          Next tyre
        </Button>
      </div>
      <div className="tr-cluster">
        <Button variant="primary" loading>
          Sending
        </Button>
        <Button disabled>Not yet</Button>
        <Routed>
          <Button to="/exceptions" variant="ghost" iconEnd={ArrowRight}>
            See the list
          </Button>
        </Routed>
      </div>
      <Button variant="primary" size="glove" block>
        Send inspection
      </Button>
      <div className="tr-cluster">
        <IconButton label="Close" icon={Close} />
        <IconButton label="Refresh" icon={Refresh} variant="secondary" />
        <IconButton label="Menu" icon={Menu} size="glove" />
      </div>
    </div>
  ),
};
