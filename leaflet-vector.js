/* eslint-disable object-shorthand, func-names, no-underscore-dangle */

import L from 'leaflet'
import { VectorTile } from 'vector-tile'
import Protobuf from 'pbf'

import * as Draw from './Draw'
import * as Geometry from './Geometry'

/**
 * Project a nested array of points.
 *
 * @param  {Array<Array<{ x: Number, y: Number }>>} unprojected
 * @param  {Number} ratio - (original / target), like 16 = 4096 / 256
 * @return {Array<Array<{ x: Number, y: Number }>>}
 */
const project = (unprojected, ratio) => unprojected.map(linestring => linestring.map(point => ({
    x: point.x / ratio,
    y: point.y / ratio,
})))

/**
 * Draw circleMarker, polyline and polygon from layers of a vector tile.
 *
 * @param  {CanvasRenderingContext2D} ctx
 * @param  {Object} layers - { layer: Array<{ feature: Feature, geometry: Geometry }> }
 * @param  {Function} style - feature => Style
 */
const drawLayers = (
    ctx,
    layers,
    style
) => {
    for (const layer of Object.values(layers)) {
        for (const object of layer) {
            const drawStyle = style(object.feature)

            switch (object.feature.type) {
            case 1:
                Draw.circleMarker(ctx, object.geometry, drawStyle)

                break
            case 2:
                Draw.polyline(ctx, object.geometry, drawStyle)

                break
            case 3:
                Draw.polygon(ctx, object.geometry, drawStyle)

                break
            default:
                break
            }
        }
    }
}

/**
 * Creates a new canvas layer for vector tiles from `url`.
 *
 * @param  {String} url
 * @param  {Object} options - { maxNativeZoom: Number, style: feature => Style, layers: [] }
 * @return {Leaflet.TileLayer.Canvas}
 */
export const Layer = L.TileLayer.Canvas.extend({
    options: {
        clickTolerance: 10,
        getFeatureId: properties => properties.id,
    },

    initialize: function(url, options = {}) {
        L.Util.setOptions(this, options)

        this._url = url
        this._highlighted = null
        this._cache = {}
        this._layers = {}
        this._visible = {}

        const subdomains = this.options.subdomains

        if (typeof subdomains === 'string') {
            this.options.subdomains = subdomains.split('')
        }

        setTimeout(() => this._updateVisible(), 3000)
    },

    drawTile: function(canvas, tilePoint) {
        const adjustedTilePoint = L.extend({}, tilePoint)
        this._adjustTilePoint(adjustedTilePoint)

        const url = this.getTileUrl(adjustedTilePoint)

        if (this._getTileSize() !== this.options.tileSize) {
            /* eslint-disable no-param-reassign */
            canvas.width = this._getTileSize()
            canvas.height = this._getTileSize()
            /* eslint-enable no-param-reassign */
        }

        this._drawTileInternal(canvas, tilePoint, url)
    },

    _drawTileInternal: function(canvas, tilePoint, url) {
        const mapZoom = this._map.getZoom()
        const zoom = this._getZoomForUrl()

        const tileKey = `${tilePoint.x}:${tilePoint.y}:${zoom}`
        const zoomTileKey = `${tilePoint.x}:${tilePoint.y}:${mapZoom}`
        const ctx = canvas.getContext('2d')

        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

        if (tileKey in this._cache) {
            if (!(zoomTileKey in this._layers)) {
                this._cacheLayers(zoomTileKey, canvas.width, this._cache[tileKey])
            }

            drawLayers(ctx, this._layers[zoomTileKey], this.options.style)

            return
        }

        fetch(url)
            .then(response => response.arrayBuffer())
            .then(buffer => {
                this._cache[tileKey] = new VectorTile(new Protobuf(buffer))
                this._cacheLayers(zoomTileKey, canvas.width, this._cache[tileKey])

                drawLayers(ctx, this._layers[zoomTileKey], this.options.style)
            })
    },

    _cacheLayers: function(tileKey, tileSize, vectorTile, layers = null) {
        this._layers[tileKey] = {}

        for (const layer of Object.values(vectorTile.layers)) {
            if (layers && !layers.includes(layer.name)) {
                continue // eslint-disable-line no-continue
            }

            this._layers[tileKey][layer.name] = []

            for (const [i] of layer._features.entries()) {
                this._layers[tileKey][layer.name].push({
                    feature: layer.feature(i),
                    geometry: project(
                        layer.feature(i).loadGeometry(),
                        layer.extent / tileSize
                    ),
                })
            }
        }
    },

    _onMoveEnd: function() {
        setTimeout(() => this._updateVisible(), 3000)
    },

    _updateVisible: function() {
        const visible = []
        const seen = []

        for (const tile of Object.values(this._layers)) {
            for (const layer of Object.values(tile)) {
                for (const object of layer) {
                    const id = object.feature.properties.osm_id
                    if (seen.indexOf(id) === -1) {
                        if (object.feature.properties.name !== '') {
                            seen.push(id)

                            visible.push({
                                osm_id: id,
                                name: object.feature.properties.name,
                                type: object.feature.type,
                            })
                        }
                    }
                }
            }
        }

        this.fireEvent('moveend', { visible: visible })
    },

    _viewreset: function() {
        const zoom = this._getZoomForUrl()
        const zoomKey = `:${zoom}`

        for (const tile of Object.keys(this._cache)) {
            if (!tile.endsWith(zoomKey)) {
                delete this._cache[tile]
            }
        }

        for (const tile of Object.keys(this._layers)) {
            if (!tile.endsWith(zoomKey)) {
                delete this._layers[tile]
            }
        }
    },

    _removeTile: function(key) {
        for (const tile of Object.keys(this._cache)) {
            if (tile.indexOf(key) === 0) {
                delete this._cache[tile]
            }
        }

        for (const tile of Object.keys(this._layers)) {
            if (tile.indexOf(key) === 0) {
                delete this._layers[tile]
            }
        }

        L.TileLayer.prototype._removeTile.call(this, key)
    },

    _onClick: function(e) {
        const zoom = this._map.getZoom()
        const [tile, tilePixel] = Geometry.latlngToTilePixel(
            e.latlng,
            this._map.options.crs,
            zoom,
            this._getTileSize(),
            this._map.getPixelOrigin(),
        )

        const tileKey = `${tile.x}:${tile.y}:${zoom}`

        if (!(tileKey in this._layers)) { return }

        const tileLayers = this._layers[tileKey]
        const layerOrder = this.options.layers || Object.keys(tileLayers)

        let foundFeature = false

        for (const layer of layerOrder) {
            for (const object of tileLayers[layer]) {
                switch (object.feature.type) {
                case 1:
                    foundFeature = Geometry.circleMarkerContainsPoint(
                        L.point(object.geometry[0][0].x, object.geometry[0][0].y),
                        10,
                        tilePixel,
                        0
                    )

                    break
                case 2:
                    foundFeature = Geometry.polylineContainsPoint(
                        object.geometry,
                        false,
                        tilePixel,
                        this.options.clickTolerance
                    )

                    break
                case 3:
                    foundFeature = Geometry.polygonContainsPoint(
                        object.geometry,
                        tilePixel,
                        0
                    )

                    break
                default:
                    break
                }

                if (foundFeature) {
                    this.fireEvent('click', object.feature.properties)
                    break
                }
            }

            if (foundFeature) {
                break
            }
        }
    },

    onAdd: function(map) {
        L.TileLayer.Canvas.prototype.onAdd.call(this, map)

        // Prevent double-clicks from behaving like clicks.
        const DELAY = 500
        let clicks = 0
        let timer = null

        map.on({
            click: e => {
                clicks += 1

                if (clicks === 1) {
                    timer = setTimeout(() => {
                        this._onClick.call(this, e)
                        clicks = 0
                    }, DELAY)
                } else {
                    clearTimeout(timer)
                    clicks = 0
                }
            },
            moveend: this._onMoveEnd,
            viewreset: this._viewreset,
        }, this)
    },

    onRemove: function(map) {
        L.TileLayer.Canvas.prototype.onRemove.call(this, map)
    },
})
