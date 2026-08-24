import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this a component from one test is still mounted during the next,
// and queries match the wrong tree.
afterEach(cleanup);
