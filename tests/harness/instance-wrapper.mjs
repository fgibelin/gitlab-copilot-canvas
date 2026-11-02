// Used when the real extension.mjs is loaded under test: same workbench, but backed by the in-memory mock.
import * as real from "../../canvas/instance.mjs";
import { makeMockService, mockDetect } from "./mock-service.mjs";

export const { DEFAULT_VIEW, mergeView } = real;
export const createWorkbench = (options) => real.createWorkbench({ ...options, detect: mockDetect, makeService: makeMockService });
