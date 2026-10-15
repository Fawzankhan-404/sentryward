import base64
import pickle

from flask import Blueprint, jsonify, make_response, request

cart = Blueprint("cart", __name__)


def load_cart():
    raw = request.cookies.get("cart")
    return pickle.loads(base64.b64decode(raw)) if raw else []


def dump_cart(items):
    return base64.b64encode(pickle.dumps(items)).decode()


@cart.get("/cart")
def show_cart():
    return jsonify(load_cart())


@cart.post("/cart")
def add_to_cart():
    items = load_cart()
    items.append({"sku": request.json["sku"], "qty": int(request.json.get("qty", 1))})
    response = make_response(jsonify(items))
    response.set_cookie("cart", dump_cart(items), httponly=True)
    return response
