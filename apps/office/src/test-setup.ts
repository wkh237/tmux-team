import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom has no layout/scroll implementation. Navigation remains the real router;
// visual scrolling is checked in the browser, not claimed by these DOM tests.
beforeEach(() => vi.spyOn(window, 'scrollTo').mockImplementation(() => {}));

afterEach(cleanup);
