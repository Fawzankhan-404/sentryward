import json

from flask import Blueprint, jsonify, make_response, request

cart = Blueprint("cart", __name__)


def load_cart():
    raw = request.cookies.get("cart")
    return json.loads(raw) if raw else []


@cart.get("/cart")
def show_cart():
    return jsonify(load_cart())


@cart.post("/cart")
def add_to_cart():
    items = load_cart()
    items.append({"sku": request.json["sku"], "qty": int(request.json.get("qty", 1))})
    response = make_response(jsonify(items))
    response.set_cookie("cart", json.dumps(items), httponly=True)
    return response
