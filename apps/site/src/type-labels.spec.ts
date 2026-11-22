import { describe, expect, test } from 'bun:test'
import { typeLabelOf } from './type-labels.ts'

describe('the labels of a note type', () => {
    test('come from the table of the site for a known type', () => {
        expect(typeLabelOf({ name: 'movies', displayName: 'Movies' })).toEqual({
            one: 'Movie',
            many: 'Movies',
            media: true
        })
        expect(typeLabelOf({ name: 'persons', displayName: 'Persons' })).toEqual({
            one: 'Person',
            many: 'People',
            media: false
        })
    })

    test('are the display name of the Starter Kit for a type that the table does not know', () => {
        expect(typeLabelOf({ name: 'recipes', displayName: 'Recipes' })).toEqual({
            one: 'Recipes',
            many: 'Recipes',
            media: false
        })
    })

    test('do not take a member of every object for a type', () => {
        expect(typeLabelOf({ name: 'constructor', displayName: 'Builders' }).one).toBe('Builders')
    })
})
