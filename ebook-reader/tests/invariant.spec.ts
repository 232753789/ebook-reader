import { describe, expect, it, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

describe('ebook-reader invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const dispose = await invariant.apply({ invariants: { register } } as never)
    expect(invariant.name).toBe('ebook-reader-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-ebook-reader', expect.any(Function))
    expect(() => { (register.mock.calls[0]![1] as (ctx: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
