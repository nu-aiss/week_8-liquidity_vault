
import { Buffer } from "buffer/";

Object.assign(globalThis, { Buffer });

void import("./main");
