import { create_tsup_config } from "../../tsup.config.base.ts";

export default create_tsup_config({ entry: ["src/index.ts", "src/node.ts"] });
