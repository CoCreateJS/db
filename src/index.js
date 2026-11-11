/********************************************************************************
 * Copyright (C) 2023-2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

import createIndex from './index/index.js'
import { createDistributedIndex } from './distributed.js'
import { createDB } from './object/index.js'
import { initializeServerDB } from './server.js'

export { createIndex, createDistributedIndex, createDB, initializeServerDB }
export default createIndex
